/**
 * The two stateful sequences the extension performs against LM Studio:
 * evict-then-preload on a model switch, and heal when something unloaded the
 * active model behind pi's back.
 *
 * Both run under the cross-process lock from sessions.ts, and both are
 * written to be callable outside pi so the integration tests can drive the
 * real sequences rather than a re-implementation of them.
 */

import { type ResolvedConfig, contextLengthFor, loadArgs, loadResolvedConfig } from "./config.ts";
import {
	type LoadedModel,
	listLoaded,
	lmsBackground,
	serverStatus,
	startServer,
	stopServer,
	unload,
	unloadAll,
} from "./lms.ts";
import {
	type AcquireOptions,
	type LockHandle,
	claimedByOthers,
	liveClaims,
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
 * Is this resident copy loaded at a different context than we want?
 *
 * Only judged once the copy has finished loading, because a copy that is
 * still loading must never be unloaded from under its load. `lastUsedTime` is
 * the signal: it stays null for the whole load and is set when the load
 * completes (LM Studio 0.4.x; on 0.3.x it stayed null until the first request).
 * The `contextLength` of a loading copy is no help — 0.3.x reported a
 * placeholder 8192 there, 0.4.x reports the requested value (see AGENTS.md).
 *
 * The cost, on 0.3.x only: a copy loaded at the wrong context and never used
 * is left alone until its first turn; the next turn then fixes it.
 */
export function hasWrongContext(entry: LoadedModel, contextLength: number | undefined): boolean {
	if (contextLength === undefined || entry.contextLength === undefined) return false;
	if (entry.lastUsedTime == null) return false;
	return entry.contextLength !== contextLength;
}

/** Is `modelKey` resident at a context we can use? */
export function isUsable(loaded: LoadedModel[], modelKey: string, contextLength: number | undefined): boolean {
	return loaded.some((entry) => matchesModelKey(entry, modelKey) && !hasWrongContext(entry, contextLength));
}

/**
 * Decide which loaded models to unload.
 *
 * Kept: one instance of the target (loading it again would give LM Studio a
 * *second* copy under `key:2` and double the memory, which is the exact
 * failure this extension exists to prevent), plus everything another live pi
 * session has claimed. Everything else goes, including surplus copies of the
 * target itself.
 *
 * With a `contextLength`, a target copy loaded at a different context is not
 * worth keeping: it goes, and the target is reloaded at the right size. The
 * unload has to come first for the same `key:2` reason. A copy another
 * session has claimed is kept as it is — that session is using it.
 */
export function planEviction(
	loaded: LoadedModel[],
	modelKey: string,
	protectedKeys: ReadonlySet<string>,
	contextLength?: number,
): { keep: LoadedModel[]; victims: LoadedModel[]; targetResident: boolean } {
	const keepIdentifiers = new Set<string>();

	const targetInstances = loaded.filter((entry) => matchesModelKey(entry, modelKey));
	const usable = targetInstances.find((entry) => !hasWrongContext(entry, contextLength));
	if (usable) keepIdentifiers.add(usable.identifier);

	for (const entry of loaded) {
		const key = entry.modelKey ?? entry.identifier;
		if (protectedKeys.has(key)) keepIdentifiers.add(entry.identifier);
	}

	return {
		keep: loaded.filter((entry) => keepIdentifiers.has(entry.identifier)),
		victims: loaded.filter((entry) => !keepIdentifiers.has(entry.identifier)),
		targetResident: targetInstances.some((entry) => keepIdentifiers.has(entry.identifier)),
	};
}

/**
 * How long a server check waits for the lock before going ahead anyway. A
 * model load can hold the lock for minutes, and the server is almost
 * certainly up in that case; a second `server start` is harmless.
 */
const SERVER_LOCK_TIMEOUT_MS = 10_000;

export interface ServerOptions {
	config?: ResolvedConfig;
	lock?: AcquireOptions;
}

/**
 * Start LM Studio's local server if `startServer` is on and it is down.
 * Resolves true when this call started it, false when nothing was needed or
 * the start failed, and undefined when the setting is off.
 *
 * `lms ps`, `lms load` and friends work without the server — they talk to
 * the LM Studio service — but pi's requests go over its HTTP API, so a
 * resident model behind a stopped server still fails every turn.
 */
export async function ensureServer(options: ServerOptions = {}): Promise<boolean | undefined> {
	const config = options.config ?? loadResolvedConfig();
	if (!config.startServer) return undefined;
	if ((await serverStatus())?.running) return false;

	return withLock(
		async (): Promise<boolean> => {
			// Re-check: another session may have started it while we queued.
			if ((await serverStatus())?.running) return false;
			return startServer();
		},
		{ timeoutMs: SERVER_LOCK_TIMEOUT_MS, ...options.lock },
	);
}

export type EvictPhase = "evicting" | "loading" | "done";

export interface EvictOptions {
	modelKey: string;
	sessionId: string;
	config?: ResolvedConfig;
	/** Context to load at. Defaults to `contextLengthFor(modelKey, config)`. */
	contextLength?: number;
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
	const contextLength = options.contextLength ?? contextLengthFor(modelKey, config);
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
			const ok = await lmsBackground(loadArgs(modelKey, config, contextLength));
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

		const { keep, victims, targetResident } = planEviction(loaded, modelKey, protectedKeys, contextLength);
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
			loadedOk = await lmsBackground(loadArgs(modelKey, config, contextLength));
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
	/** Context the model must be loaded at. Defaults to `contextLengthFor(modelKey, config)`. */
	contextLength?: number;
	lock?: AcquireOptions;
	onProgress?: (phase: "checking" | "loading" | "done") => void;
}

export interface HealOutcome {
	/** False when `lms` could not be reached, so nothing is known. */
	checked: boolean;
	/** True when the model was found missing from memory. */
	wasEvicted: boolean;
	/**
	 * True when the model was resident but at the wrong context length. It is
	 * reloaded unless another live session has claimed it (then `reloaded`
	 * stays false and the copy is left as it is).
	 */
	wrongContext?: boolean;
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
 *
 * The one unload it does is of the target itself, when it is resident at the
 * wrong context length (typically a just-in-time load at LM Studio's small
 * default). Reloading without unloading first would leave a `key:2` copy.
 */
export async function healIfEvicted(options: HealOptions): Promise<HealOutcome> {
	const started = Date.now();
	const config = options.config ?? loadResolvedConfig();
	const { modelKey, sessionId } = options;
	const contextLength = options.contextLength ?? contextLengthFor(modelKey, config);
	const progress = options.onProgress ?? (() => {});

	progress("checking");
	const loaded = await listLoaded();
	if (!loaded) {
		return { checked: false, wasEvicted: false, reloaded: false, ok: false, durationMs: Date.now() - started };
	}
	if (isUsable(loaded, modelKey, contextLength)) {
		return { checked: true, wasEvicted: false, reloaded: false, ok: true, durationMs: Date.now() - started };
	}

	return withLock(async (_locked, handle): Promise<HealOutcome> => {
		// Re-check inside the lock: another session (or a switch that was
		// already in flight) may have loaded it while we queued. Loads this
		// extension starts run under the lock, so any of ours have settled by
		// now and their context is real.
		const current = await listLoaded();
		if (current && isUsable(current, modelKey, contextLength)) {
			return { checked: true, wasEvicted: true, reloaded: false, ok: true, durationMs: Date.now() - started };
		}

		const stale = (current ?? []).filter(
			(entry) => matchesModelKey(entry, modelKey) && hasWrongContext(entry, contextLength),
		);
		const wrongContext = stale.length > 0;
		if (wrongContext) {
			const claimed = config.multiSessionSafety ? claimedByOthers(sessionId) : new Set<string>();
			// Another session is using this copy as it is, or the lock was taken
			// from us: unloading now could cut off a response. Leave it.
			if (claimed.has(modelKey) || (handle && !handle.isValid())) {
				return {
					checked: true,
					wasEvicted: false,
					wrongContext,
					reloaded: false,
					ok: true,
					durationMs: Date.now() - started,
				};
			}
			for (const entry of stale) await unload(entry.identifier);
		}

		progress("loading");
		// `keepAlive` because this is awaited and the caller acts on the
		// result: the turn is being held open for it. Without it the host can
		// exit the instant its event loop empties, mid-load.
		const ok = await lmsBackground(loadArgs(modelKey, config, contextLength), { keepAlive: true });
		progress("done");
		return {
			checked: true,
			wasEvicted: !wrongContext,
			wrongContext,
			reloaded: true,
			ok,
			durationMs: Date.now() - started,
		};
	}, options.lock);
}

/**
 * How long quitting waits for the lock. Quitting must stay quick; past this
 * the body runs anyway, and its claim check still protects other sessions.
 */
const QUIT_LOCK_TIMEOUT_MS = 5_000;

export interface QuitOptions {
	/** The model this session was using, if it was an LM Studio one. */
	modelKey?: string;
	sessionId: string;
	config?: ResolvedConfig;
	lock?: AcquireOptions;
}

export interface QuitOutcome {
	/** Identifiers unloaded, including any surplus `key:n` copies. */
	unloaded: string[];
	/** True when the model was left loaded because another live session claims it. */
	spared: boolean;
	stoppedServer: boolean;
	durationMs: number;
}

/**
 * Release what this session held when pi quits: its model (`unloadOnQuit`)
 * and, if it was the last live pi session, the server (`stopServerOnQuit`).
 *
 * Only for a real quit. `/new`, `/resume` and reload also shut a session
 * down, but the same process carries on and would just load the model again.
 */
export async function releaseOnQuit(options: QuitOptions): Promise<QuitOutcome> {
	const started = Date.now();
	const config = options.config ?? loadResolvedConfig();
	const { modelKey, sessionId } = options;
	const outcome: QuitOutcome = { unloaded: [], spared: false, stoppedServer: false, durationMs: 0 };
	if (!config.unloadOnQuit && !config.stopServerOnQuit) return outcome;

	return withLock(
		async (_locked, handle): Promise<QuitOutcome> => {
			if (config.unloadOnQuit && modelKey) {
				const claimed = config.multiSessionSafety ? claimedByOthers(sessionId) : new Set<string>();
				if (claimed.has(modelKey) || (handle && !handle.isValid())) {
					outcome.spared = true;
				} else {
					for (const entry of (await listLoaded()) ?? []) {
						if (!matchesModelKey(entry, modelKey)) continue;
						if (await unload(entry.identifier)) outcome.unloaded.push(entry.identifier);
					}
				}
			}
			// Other pi sessions count whatever model they are on, LM Studio or
			// not yet: they may switch to one, and the server is shared.
			const othersAlive = liveClaims().some((claim) => claim.sessionId !== sessionId);
			if (config.stopServerOnQuit && !othersAlive) outcome.stoppedServer = await stopServer();
			outcome.durationMs = Date.now() - started;
			return outcome;
		},
		{ timeoutMs: QUIT_LOCK_TIMEOUT_MS, ...options.lock },
	);
}
