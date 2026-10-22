/**
 * The two stateful sequences the extension performs against LM Studio:
 * evict-then-preload on a model switch, and heal when something unloaded the
 * active model behind pi's back.
 *
 * Both run under the cross-process lock from sessions.ts, and both are
 * written to be callable outside pi so the integration tests can drive the
 * real sequences rather than a re-implementation of them.
 */

import { type ResolvedConfig, loadArgs, loadResolvedConfig } from "./config.ts";
import { type LoadedModel, listLoaded, lmsBackground, unload, unloadAll } from "./lms.ts";
import {
	type AcquireOptions,
	type LockHandle,
	claimedByOthers,
	pruneDeadClaims,
	withLock,
} from "./sessions.ts";

/**
 * pi model ids can carry the provider prefix in multi-server setups
 * (e.g. "lmstudio/desktop/qwen3-coder-30b"); `lms load` wants the bare key.
 */
export function bareModelKey(provider: string, id: string): string {
	return id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
}

/**
 * Does this `lms ps` entry represent `modelKey`?
 *
 * `identifier` is normally the model key, but LM Studio appends `:2`, `:3`, …
 * when the same model is loaded more than once, and `--identifier` can set it
 * to anything. `modelKey` is the stable identity; the suffix forms are
 * accepted as a fallback for entries that lack it.
 */
export function matchesModelKey(entry: LoadedModel, modelKey: string): boolean {
	if (entry.modelKey === modelKey) return true;
	if (entry.identifier === modelKey) return true;
	return entry.identifier?.startsWith(`${modelKey}:`) === true;
}

/**
 * Identifiers of extra copies: every entry after the first one listed for the
 * same model. That is the copy `planEviction` would keep when the model is the
 * target, so these are the ones it would reap — but it is a statement about
 * list order, not about which copy is "the original". A second copy loaded on
 * purpose under a custom `--identifier` counts too; the memory is spent twice
 * either way.
 *
 * Entries without a `modelKey` are grouped by their identifier minus a
 * trailing `:n`, which is narrower than `matchesModelKey`'s prefix test (that
 * one has the target key to anchor on; here there is none).
 */
export function duplicateIdentifiers(loaded: LoadedModel[]): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const entry of loaded) {
		const key = entry.modelKey ?? entry.identifier.replace(/:\d+$/, "");
		if (seen.has(key)) duplicates.add(entry.identifier);
		else seen.add(key);
	}
	return duplicates;
}

/** Is `modelKey` resident right now? */
export function isResident(loaded: LoadedModel[], modelKey: string): boolean {
	return loaded.some((entry) => matchesModelKey(entry, modelKey));
}

/**
 * Decide which loaded models to unload.
 *
 * Kept: one instance of the target (loading it again would give LM Studio a
 * *second* copy under `key:2` and double the memory, which is the exact
 * failure this extension exists to prevent), plus everything another live pi
 * session has claimed. Everything else goes, including surplus copies of the
 * target itself.
 */
export function planEviction(
	loaded: LoadedModel[],
	modelKey: string,
	protectedKeys: ReadonlySet<string>,
): { keep: LoadedModel[]; victims: LoadedModel[]; targetResident: boolean } {
	const keepIdentifiers = new Set<string>();

	const targetInstances = loaded.filter((entry) => matchesModelKey(entry, modelKey));
	if (targetInstances[0]) keepIdentifiers.add(targetInstances[0].identifier);

	for (const entry of loaded) {
		const key = entry.modelKey ?? entry.identifier;
		if (protectedKeys.has(key)) keepIdentifiers.add(entry.identifier);
	}

	return {
		keep: loaded.filter((entry) => keepIdentifiers.has(entry.identifier)),
		victims: loaded.filter((entry) => !keepIdentifiers.has(entry.identifier)),
		targetResident: targetInstances.length > 0,
	};
}

export type EvictPhase = "evicting" | "loading" | "done";

export interface EvictOptions {
	modelKey: string;
	sessionId: string;
	config?: ResolvedConfig;
	lock?: AcquireOptions;
	onProgress?: (phase: EvictPhase, detail?: string) => void;
}

export interface EvictOutcome {
	/** False when the lock could not be taken and we proceeded anyway. */
	locked: boolean;
	/** Identifiers unloaded during this sequence. */
	unloaded: string[];
	/** Identifiers deliberately left resident (target, other sessions' models). */
	spared: string[];
	/** True when the target was already in memory, so no load was issued. */
	alreadyResident: boolean;
	/** False when the `lms load` failed or was never run. */
	loaded: boolean;
	/**
	 * True when the lock was taken from us mid-sequence and we declined to
	 * unload anything. Rare, and the point of detecting it: another session
	 * believes it owns the eviction, so the safe move is to do nothing rather
	 * than unload a model it just loaded.
	 */
	abandoned?: boolean;
	durationMs: number;
}

/**
 * Unload what should go, then load `modelKey` — strictly sequenced, because
 * loading before the unload finishes would briefly hold two models in memory,
 * or let an `unload --all` kill the load in progress.
 */
export async function evictThenPreload(options: EvictOptions): Promise<EvictOutcome> {
	const started = Date.now();
	const config = options.config ?? loadResolvedConfig();
	const { modelKey, sessionId } = options;
	const progress = options.onProgress ?? (() => {});

	return withLock(async (locked, handle): Promise<EvictOutcome> => {
		// Housekeeping under the lock: a session that was hard-killed leaves
		// its claim file behind, and nothing else ever removes it if pi is
		// not started again on this machine.
		pruneDeadClaims();

		const protectedKeys = config.multiSessionSafety
			? claimedByOthers(sessionId)
			: new Set<string>();

		progress("evicting");
		const loaded = await listLoaded();

		// `lms` unreachable: fall back to the blunt sequence, which is still
		// the right thing to attempt and stays silent if lms is simply absent.
		if (!loaded) {
			await unloadAll();
			progress("loading", modelKey);
			const ok = await lmsBackground(loadArgs(modelKey, config));
			progress("done");
			return {
				locked,
				unloaded: [],
				spared: [],
				alreadyResident: false,
				loaded: ok,
				durationMs: Date.now() - started,
			};
		}

		const { keep, victims, targetResident } = planEviction(loaded, modelKey, protectedKeys);
		const unloaded: string[] = [];

		// Last check before anything destructive. A lock can be taken from us
		// by a concurrent stale-breaker (see sessions.ts — no filesystem lock
		// in pure Node can prevent that), and unloading on a stolen lock is
		// exactly the double-eviction the lock exists to avoid. Checking here
		// shrinks the exposure from the whole multi-minute sequence to a
		// single token read.
		if (handle && !handle.isValid()) {
			progress("done");
			return {
				locked,
				unloaded: [],
				spared: keep.map((entry) => entry.identifier),
				alreadyResident: targetResident,
				loaded: false,
				abandoned: true,
				durationMs: Date.now() - started,
			};
		}

		if (victims.length > 0 && keep.length === 0) {
			// Nothing to preserve — one call is faster, and catches anything
			// `lms ps` might not have listed.
			if (await unloadAll()) unloaded.push(...victims.map((v) => v.identifier));
		} else {
			for (const victim of victims) {
				if (await unload(victim.identifier)) unloaded.push(victim.identifier);
			}
		}

		let loadedOk = false;
		if (!targetResident) {
			progress("loading", modelKey);
			loadedOk = await lmsBackground(loadArgs(modelKey, config));
		}

		progress("done");
		return {
			locked,
			unloaded,
			spared: keep.map((entry) => entry.identifier),
			alreadyResident: targetResident,
			loaded: loadedOk,
			durationMs: Date.now() - started,
		};
	}, options.lock);
}

export interface HealOptions {
	modelKey: string;
	sessionId: string;
	config?: ResolvedConfig;
	lock?: AcquireOptions;
	onProgress?: (phase: "checking" | "loading" | "done") => void;
}

export interface HealOutcome {
	/** False when `lms` could not be reached, so nothing is known. */
	checked: boolean;
	/** True when the model was found missing from memory. */
	wasEvicted: boolean;
	/** True when this call issued the reload (false if another session beat us). */
	reloaded: boolean;
	/** False when the reload was attempted and failed. */
	ok: boolean;
	durationMs: number;
}

/**
 * Put the active model back in memory if something removed it: an idle TTL
 * firing, an unload from the LM Studio GUI, or a model switch that was
 * skipped because the agent was mid-stream.
 *
 * Deliberately narrow — it reloads the target and nothing else. Evicting
 * strangers here would mean surprise unloads at prompt time; the next model
 * switch applies the full policy.
 */
export async function healIfEvicted(options: HealOptions): Promise<HealOutcome> {
	const started = Date.now();
	const config = options.config ?? loadResolvedConfig();
	const { modelKey } = options;
	const progress = options.onProgress ?? (() => {});

	progress("checking");
	const loaded = await listLoaded();
	if (!loaded) {
		return { checked: false, wasEvicted: false, reloaded: false, ok: false, durationMs: Date.now() - started };
	}
	if (isResident(loaded, modelKey)) {
		return { checked: true, wasEvicted: false, reloaded: false, ok: true, durationMs: Date.now() - started };
	}

	return withLock(async (): Promise<HealOutcome> => {
		// Re-check inside the lock: another session (or a switch that was
		// already in flight) may have loaded it while we queued.
		const current = await listLoaded();
		if (current && isResident(current, modelKey)) {
			return { checked: true, wasEvicted: true, reloaded: false, ok: true, durationMs: Date.now() - started };
		}
		progress("loading");
		// `keepAlive` because this is awaited and the caller acts on the
		// result: the turn is being held open for it. Without it the host can
		// exit the instant its event loop empties, mid-load.
		const ok = await lmsBackground(loadArgs(modelKey, config), { keepAlive: true });
		progress("done");
		return { checked: true, wasEvicted: true, reloaded: true, ok, durationMs: Date.now() - started };
	}, options.lock);
}
