/**
 * pi-lmstudio-evict
 *
 * Keeps LM Studio's memory footprint bounded at one model at a time, and
 * keeps the model pi thinks is active actually resident.
 *
 *   model_select        unload what should go, preload the new model
 *   before_agent_start  reload the active model if something evicted it
 *   session_start       sync models.json with LM Studio's catalogue
 *   session_shutdown    drop this session's claim
 *
 * `/lmstudio-evict-model` (also `/llm-evict-model`, `/model-load-unload`,
 * `/llm-load-unload`) opens a picker over the catalogue for manual
 * load/unload, shows what each model is and what it would cost, and holds
 * the settings.
 *
 * The automatic paths are silent on errors: if `lms` is not on PATH or the
 * local server is down, the extension is a no-op and pi keeps working. The
 * command reports errors, since the user is watching.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type EvictConfig,
	contextLengthFor,
	loadArgs,
	loadConfig,
	loadResolvedConfig,
	modelsJsonPath,
	saveConfig,
} from "./lib/config.ts";
import {
	type CatalogModel,
	type LoadedModel,
	type MemoryEstimate,
	estimateMemory,
	listCatalog,
	listLoaded,
	lmsBackground,
	lmsRun,
	serverStatus,
} from "./lib/lms.ts";
import { CANCELLED, withLoader, withStatus } from "./lib/loading.ts";
import { type Fit, fitOf, formatBytes, ram, vram } from "./lib/memory.ts";
import {
	bareModelKey,
	duplicateIdentifiers,
	evictThenPreload,
	healIfEvicted,
	isResident,
	matchesModelKey,
} from "./lib/orchestrator.ts";
import { chatModels, describeSync, syncModelsJson } from "./lib/registry.ts";
import { dropClaim, newSessionId, pruneDeadClaims, writeClaim } from "./lib/sessions.ts";

/**
 * Provider prefix we care about. Matches both:
 *   - "lmstudio"             (manual models.json, or single-server pi-lmstudio)
 *   - "lmstudio/desktop"     (multi-server pi-lmstudio with named urls)
 */
const PROVIDER_PREFIX = "lmstudio";

/** Stable id for footer status lines. */
const STATUS_KEY = "pi-lmstudio-evict";

/** Every name the model picker answers to; the first is the canonical one. */
const COMMAND_NAMES = ["lmstudio-evict-model", "llm-evict-model", "model-load-unload", "llm-load-unload"];

/**
 * How long a "the model is resident" observation stays good enough to skip
 * the `lms ps` round trip before a turn. Half a second on every prompt is
 * worth avoiding; no real idle TTL is anywhere near this short.
 */
const RESIDENCY_CACHE_MS = 15_000;

/**
 * Cap on how long a turn will wait for a heal. Past this the prompt goes
 * through anyway — LM Studio will just-in-time load the model itself, so the
 * worst case is the latency we were trying to avoid, not a failure.
 */
const HEAL_WAIT_MS = 5 * 60_000;

/** Budget for collecting `--estimate-only` figures before opening the picker. */
const ESTIMATE_BUDGET_MS = 12_000;
const ESTIMATE_CONCURRENCY = 4;

export default function (pi: ExtensionAPI) {
	// One identity per pi process, used to tell our own claim from other
	// sessions' claims in the shared claims directory.
	const sessionId = newSessionId();
	/** Epoch ms of the last confirmed sighting of the active model in memory. */
	let residentAt = 0;

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// Modes without a footer (print, RPC) — nothing to show.
		}
	};

	/** Bare `lms` key for the active model, or undefined when it isn't LM Studio's. */
	const activeModelKey = (ctx: ExtensionContext): string | undefined => {
		const provider = ctx.model?.provider;
		if (!provider?.startsWith(PROVIDER_PREFIX) || !ctx.model) return undefined;
		return bareModelKey(provider, ctx.model.id);
	};

	/** Residency check interval, tightened when a short TTL is configured. */
	const residencyCacheMs = (config: EvictConfig): number => {
		const ttl = config.ttlSeconds;
		if (typeof ttl === "number" && ttl > 0) {
			return Math.min(RESIDENCY_CACHE_MS, Math.floor((ttl * 1000) / 3));
		}
		return RESIDENCY_CACHE_MS;
	};

	// -----------------------------------------------------------------------
	// Startup: catalogue sync and claim registration
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		pruneDeadClaims();
		writeClaim(sessionId, activeModelKey(ctx));

		const config = loadResolvedConfig();
		if (!config.autoRegisterModels) return;

		const [catalog, server] = await Promise.all([listCatalog(), serverStatus()]);
		if (!catalog) return; // lms unreachable — stay quiet, as everywhere else.

		const result = syncModelsJson({
			modelsPath: modelsJsonPath(),
			catalog,
			baseUrl: `http://localhost:${server?.port ?? 1234}/v1`,
		});
		if (result.error || !result.changed) return;

		// Make the new catalogue visible to /model without a restart.
		try {
			await ctx.modelRegistry.refresh();
		} catch {
			// Refresh is a convenience; the file on disk is already correct.
		}
		ctx.ui.notify(
			`LM Studio: ${describeSync(result)}${result.removed.length ? ` — removed ${result.removed.join(", ")}` : ""}`,
			"info",
		);
	});

	pi.on("session_shutdown", async () => {
		dropClaim(sessionId);
	});

	// -----------------------------------------------------------------------
	// Model switch: evict, then preload
	// -----------------------------------------------------------------------

	pi.on("model_select", async (event, ctx) => {
		const provider = event.model.provider;
		if (!provider?.startsWith(PROVIDER_PREFIX)) {
			// Moved off LM Studio: stop protecting whatever we held.
			writeClaim(sessionId, undefined);
			return;
		}

		const modelKey = bareModelKey(provider, event.model.id);
		writeClaim(sessionId, modelKey);
		// Force a residency check on the next turn.
		residentAt = 0;

		// Don't fight the user's restored state. Session restore replays the
		// model that was active in the saved session; evicting would force an
		// unnecessary reload of the same model on first prompt.
		if (event.source === "restore") return;

		// No-op for the same model being re-selected (rare, but happens
		// during Ctrl+P cycling when the picker wraps).
		if (event.previousModel?.provider === provider && event.previousModel.id === event.model.id) {
			return;
		}

		// Safety: if the agent is mid-turn, skip. Unloading the model that is
		// currently streaming would interrupt the in-flight response — the
		// heal on the next turn picks up the pieces.
		if (!ctx.isIdle()) return;

		// Deliberately not awaited: a model load takes tens of seconds and pi
		// must not block on it. Progress goes to the footer instead.
		void (async () => {
			try {
				const outcome = await evictThenPreload({
					modelKey,
					sessionId,
					onProgress: (phase, detail) => {
						if (phase === "evicting") setStatus(ctx, "lmstudio: evicting…");
						else if (phase === "loading") setStatus(ctx, `lmstudio: loading ${detail}…`);
					},
				});
				setStatus(ctx, undefined);
				if (outcome.alreadyResident || outcome.loaded) residentAt = Date.now();
			} catch {
				setStatus(ctx, undefined);
			}
		})();
	});

	// -----------------------------------------------------------------------
	// Turn start: heal a model that was evicted behind pi's back
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async (_event, ctx) => {
		const modelKey = activeModelKey(ctx);
		if (!modelKey) return;

		// Refresh the claim whatever the heal setting says: it is what stops
		// other sessions evicting this model out from under the turn.
		writeClaim(sessionId, modelKey);

		const config = loadResolvedConfig();
		if (!config.healEvictions) return;
		if (Date.now() - residentAt < residencyCacheMs(config)) return;

		const heal = healIfEvicted({
			modelKey,
			sessionId,
			config,
			onProgress: (phase) => {
				if (phase === "loading") setStatus(ctx, `lmstudio: reloading ${modelKey}…`);
			},
		});

		// Bounded: past the cap the prompt goes through and LM Studio
		// just-in-time loads the model itself.
		const timeout = new Promise<undefined>((resolve) => {
			setTimeout(() => resolve(undefined), HEAL_WAIT_MS).unref?.();
		});

		try {
			const outcome = await Promise.race([heal, timeout]);
			setStatus(ctx, undefined);
			// Undefined means the cap expired; the model may still be loading.
			if (!outcome?.checked || !outcome.ok) return;
			residentAt = Date.now();
			if (outcome.reloaded && outcome.wrongContext) {
				const context = contextLengthFor(modelKey, config);
				ctx.ui.notify(`${modelKey} was loaded at the wrong context — reloaded it at ${context}`, "info");
			} else if (outcome.reloaded) {
				ctx.ui.notify(`LM Studio had evicted ${modelKey} — reloaded it`, "info");
			}
		} catch {
			setStatus(ctx, undefined);
		}
	});

	// -----------------------------------------------------------------------
	// /lmstudio-evict-model
	// -----------------------------------------------------------------------

	/** Run `estimateMemory` over many models within a fixed time budget. */
	const collectEstimates = async (
		keys: string[],
		signal?: AbortSignal,
	): Promise<Map<string, MemoryEstimate | undefined>> => {
		const results = new Map<string, MemoryEstimate | undefined>();
		const queue = [...keys];
		const worker = async () => {
			for (;;) {
				// A cancelled picker has no use for the remaining figures.
				if (signal?.aborted) return;
				const key = queue.shift();
				if (key === undefined) return;
				results.set(key, await estimateMemory(key));
			}
		};
		const workers = Array.from({ length: Math.min(ESTIMATE_CONCURRENCY, keys.length) }, worker);
		const budget = new Promise<void>((resolve) => {
			setTimeout(resolve, ESTIMATE_BUDGET_MS).unref?.();
		});
		// Whatever finished by the deadline is what the picker shows; the rest
		// fall back to file size.
		await Promise.race([Promise.all(workers), budget]);
		return results;
	};

	/** "12B Q4_0 gemma4 · vision, tools · ctx 262144" */
	const describeModel = (model: CatalogModel | LoadedModel, loaded?: LoadedModel): string => {
		const bits: string[] = [];
		const spec = [model.paramsString, model.quantization?.name, model.architecture]
			.filter(Boolean)
			.join(" ");
		if (spec) bits.push(spec);

		const abilities: string[] = [];
		if (model.vision) abilities.push("vision");
		if (model.trainedForToolUse) abilities.push("tools");
		if (abilities.length) bits.push(abilities.join(", "));

		const max = model.maxContextLength;
		const current = loaded?.contextLength;
		if (current && max && current !== max) bits.push(`ctx ${current}/${max}`);
		else if (max) bits.push(`ctx ${max}`);

		return bits.join(" · ");
	};

	const modelPicker = {
		description: "List LM Studio models, load/unload them, and manage eviction settings",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const config = loadResolvedConfig();

			// Everything the picker needs is gathered behind a loader: `lms`
			// round trips plus up to ESTIMATE_BUDGET_MS of estimates is long
			// enough that a silent pause reads as a hang.
			const gathered = await withLoader(ctx, "Reading LM Studio models…", async (signal) => {
				const [loaded, catalogRaw, gpu] = await Promise.all([listLoaded(), listCatalog(), vram()]);
				if (!loaded) return undefined;
				const notLoaded = chatModels(catalogRaw ?? []).filter((m) => !isResident(loaded, m.modelKey));
				const estimates = config.useMemoryEstimate
					? await collectEstimates(
							notLoaded.map((m) => m.modelKey),
							signal,
						)
					: new Map<string, MemoryEstimate | undefined>();
				return { loaded, notLoaded, gpu, estimates };
			});
			if (gathered === CANCELLED) return;
			if (!gathered) {
				ctx.ui.notify("Can't reach LM Studio — is `lms` on PATH and the server running?", "error");
				return;
			}
			const { loaded, notLoaded, gpu, estimates } = gathered;

			const theme = ctx.ui.theme;
			const ramPool = ram();

			/**
			 * Size a candidate model. LM Studio's own estimate is preferred:
			 * it includes runtime overhead that raw file size omits. Its
			 * guardrail verdict, when present, overrides our arithmetic —
			 * LM Studio knows about settings we cannot see.
			 */
			const sizeLabel = (modelKey: string, fileBytes: number | undefined): string => {
				const estimate = estimates.get(modelKey);
				const bytes = estimate?.totalBytes ?? fileBytes;
				const text = formatBytes(bytes) + (estimate?.totalBytes !== undefined ? "" : " (file)");
				let fit: Fit = fitOf(bytes, ramPool.freeBytes, gpu?.freeBytes);
				if (estimate?.passesGuardrails === false) fit = "over";
				if (fit === "over") return theme.fg("error", text);
				if (fit === "tight") return theme.fg("warning", text);
				return text;
			};

			const options: string[] = [];
			const actions = new Map<string, () => Promise<void>>();
			const add = (label: string, action: () => Promise<void>) => {
				// select() returns the chosen label, so labels must be unique.
				let unique = label;
				for (let n = 2; actions.has(unique); n++) unique = `${label} #${n}`;
				options.push(unique);
				actions.set(unique, action);
			};

			const duplicates = duplicateIdentifiers(loaded);
			for (const model of loaded) {
				const ttl = model.ttlMs ? `, ttl ${Math.round(model.ttlMs / 60_000)}min` : "";
				const info = describeModel(model, model);
				const marker = duplicates.has(model.identifier)
					? `${theme.fg("error", "●")} ${theme.fg("success", model.identifier)} ${theme.fg("error", "(DUPLICATE)")}`
					: `● ${theme.fg("success", model.identifier)}`;
				add(
					`${marker} — ${formatBytes(model.sizeBytes)}${ttl}${info ? ` · ${info}` : ""} — unload`,
					async () => {
						ctx.ui.notify(`Unloading ${model.identifier}…`, "info");
						const ok = await withStatus(ctx, `lmstudio: unloading ${model.identifier}…`, () =>
							lmsRun(["unload", model.identifier]),
						);
						ctx.ui.notify(
							ok ? `Unloaded ${model.identifier}` : `Failed to unload ${model.identifier}`,
							ok ? "info" : "error",
						);
					},
				);
			}

			if (loaded.length > 1) {
				add(`●● unload all ${loaded.length} models`, async () => {
					ctx.ui.notify(`Unloading ${loaded.length} models…`, "info");
					const ok = await withStatus(ctx, `lmstudio: unloading ${loaded.length} models…`, () =>
						lmsRun(["unload", "--all"]),
					);
					ctx.ui.notify(
						ok ? `Unloaded ${loaded.length} models` : "Unload failed",
						ok ? "info" : "error",
					);
				});
			}

			for (const model of notLoaded) {
				const info = describeModel(model);
				add(
					`○ ${model.modelKey} — ${sizeLabel(model.modelKey, model.sizeBytes)}${info ? ` · ${info}` : ""} — load`,
					async () => {
						ctx.ui.notify(`Loading ${model.modelKey} in the background…`, "info");
						const ok = await withStatus(ctx, `lmstudio: loading ${model.modelKey}…`, () =>
							lmsBackground(loadArgs(model.modelKey, loadConfig(), contextLengthFor(model.modelKey))),
						);
						ctx.ui.notify(
							ok ? `Loaded ${model.modelKey}` : `Failed to load ${model.modelKey}`,
							ok ? "info" : "error",
						);
					},
				);
			}

			add("⟳ Sync models.json with LM Studio now", async () => {
				const [fresh, server] = await withStatus(ctx, "lmstudio: syncing models.json…", () =>
					Promise.all([listCatalog(), serverStatus()]),
				);
				if (!fresh) {
					ctx.ui.notify("Can't read the LM Studio catalogue", "error");
					return;
				}
				const result = syncModelsJson({
					modelsPath: modelsJsonPath(),
					catalog: fresh,
					baseUrl: `http://localhost:${server?.port ?? 1234}/v1`,
				});
				if (!result.error && result.changed) {
					try {
						await ctx.modelRegistry.refresh();
					} catch {
						// The file is correct even if the live refresh failed.
					}
				}
				ctx.ui.notify(describeSync(result), result.error ? "error" : "info");
			});

			const SETTINGS = "⚙ Settings…";
			options.push(SETTINGS);

			const memory = [
				`RAM ${formatBytes(ramPool.freeBytes)} free of ${formatBytes(ramPool.totalBytes)}`,
			];
			if (gpu) {
				memory.push(`VRAM ${formatBytes(gpu.freeBytes)} free of ${formatBytes(gpu.totalBytes)}`);
			}
			const title = `LM Studio models — ${memory.join(" · ")}`;

			// Settings is a submenu, not an action: leaving it (Escape) comes back
			// here rather than closing the picker. The list is reused as built —
			// the estimates were the expensive part and nothing in Settings
			// changes what is loaded.
			for (;;) {
				const choice = await ctx.ui.select(title, options);
				if (choice === undefined) return;
				if (choice === SETTINGS) {
					await settingsMenu(ctx);
					continue;
				}
				await actions.get(choice)?.();
				return;
			}
		},
	};

	/**
	 * Second-level menu holding everything that is a setting rather than a
	 * model. Stays open after each change, with labels re-read from disk, so
	 * several settings can be adjusted in one visit; Escape returns to the
	 * model list.
	 */
	const settingsMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
		for (;;) {
			const applied = await settingsMenuOnce(ctx);
			if (!applied) return;
		}
	};

	/** One round of the settings menu. Resolves false when the user backed out. */
	const settingsMenuOnce = async (ctx: ExtensionCommandContext): Promise<boolean> => {
		const config = loadResolvedConfig();
		const onOff = (value: boolean) => (value ? "on" : "off");

		const entries: { label: string; apply: () => Promise<void> | void }[] = [
			{
				label: config.ttlSeconds
					? `TTL: unload after ${config.ttlSeconds}s idle`
					: "TTL: off — models stay loaded until the next switch",
				apply: async () => {
					const stored = loadConfig();
					const raw = await ctx.ui.input(
						"Idle TTL in seconds for models this extension loads (empty or 0 = off)",
						stored.ttlSeconds ? String(stored.ttlSeconds) : "",
					);
					if (raw === undefined) return;
					const trimmed = raw.trim();
					if (trimmed === "" || trimmed === "0" || trimmed === "off") {
						delete stored.ttlSeconds;
						saveConfig(stored);
						ctx.ui.notify("TTL off — models stay loaded until the next switch", "info");
						return;
					}
					const seconds = Number.parseInt(trimmed, 10);
					if (!Number.isFinite(seconds) || seconds <= 0) {
						ctx.ui.notify(`Not a valid TTL: ${trimmed}`, "error");
						return;
					}
					stored.ttlSeconds = seconds;
					saveConfig(stored);
					ctx.ui.notify(`TTL set — idle models unload after ${seconds}s`, "info");
				},
			},
			{
				label: config.contextLength
					? `Context length: ${config.contextLength} tokens`
					: "Context length: LM Studio's default",
				apply: async () => {
					const stored = loadConfig();
					const raw = await ctx.ui.input(
						"Context length to load models with, in tokens (empty or 0 = LM Studio's default)",
						stored.contextLength ? String(stored.contextLength) : "",
					);
					if (raw === undefined) return;
					const trimmed = raw.trim();
					if (trimmed === "" || trimmed === "0" || trimmed === "off") {
						delete stored.contextLength;
						saveConfig(stored);
						ctx.ui.notify("Context length off — LM Studio picks its default", "info");
						return;
					}
					const length = Number.parseInt(trimmed, 10);
					if (!Number.isFinite(length) || length <= 0) {
						ctx.ui.notify(`Not a valid context length: ${trimmed}`, "error");
						return;
					}
					stored.contextLength = length;
					saveConfig(stored);
					ctx.ui.notify(`Context length set — models load at ${length} tokens`, "info");
				},
			},
			{
				label: config.extraLoadArgs?.length
					? `Extra load flags: ${config.extraLoadArgs.join(" ")}`
					: "Extra load flags: none",
				apply: async () => {
					const stored = loadConfig();
					const raw = await ctx.ui.input(
						"Extra `lms load` flags, space-separated (e.g. --gpu max --parallel 2); empty = none",
						stored.extraLoadArgs?.join(" ") ?? "",
					);
					if (raw === undefined) return;
					const args = raw.trim().split(/\s+/).filter(Boolean);
					if (args.length === 0) delete stored.extraLoadArgs;
					else stored.extraLoadArgs = args;
					saveConfig(stored);
					ctx.ui.notify(args.length ? `Extra load flags: ${args.join(" ")}` : "Extra load flags cleared", "info");
				},
			},
			toggle(
				ctx,
				"matchContextWindow",
				`Match contextWindow: ${onOff(config.matchContextWindow)} — load at a hand-written models.json window`,
			),
			toggle(
				ctx,
				"healEvictions",
				`Heal evictions: ${onOff(config.healEvictions)} — reload the active model if something unloads it`,
			),
			toggle(
				ctx,
				"multiSessionSafety",
				`Multi-session safety: ${onOff(config.multiSessionSafety)} — spare models other pi sessions are using`,
			),
			toggle(
				ctx,
				"autoRegisterModels",
				`Auto-register models: ${onOff(config.autoRegisterModels)} — keep models.json in step with LM Studio`,
			),
			toggle(
				ctx,
				"useMemoryEstimate",
				`Memory estimate: ${onOff(config.useMemoryEstimate)} — size models via lms --estimate-only`,
			),
		];

		const choice = await ctx.ui.select("pi-lmstudio-evict settings", entries.map((e) => e.label));
		if (choice === undefined) return false;
		await entries.find((e) => e.label === choice)?.apply();
		return true;
	};

	/** A boolean setting rendered as one flip-on-select menu entry. */
	function toggle(
		ctx: ExtensionCommandContext,
		key:
			| "healEvictions"
			| "multiSessionSafety"
			| "autoRegisterModels"
			| "useMemoryEstimate"
			| "matchContextWindow",
		label: string,
	): { label: string; apply: () => void } {
		return {
			label,
			apply: () => {
				const stored: EvictConfig = loadConfig();
				const next = !loadResolvedConfig()[key];
				stored[key] = next;
				saveConfig(stored);
				ctx.ui.notify(`${key} ${next ? "on" : "off"}`, "info");
			},
		};
	}

	// The command palette fuzzy-matches on command *names* only, so the picker is
	// registered under every name people are likely to type: "model" and "llm"
	// for what it manages, "load"/"unload" for what it does.
	for (const name of COMMAND_NAMES) pi.registerCommand(name, modelPicker);
}

// Re-exported so the integration tests can exercise the same helpers the
// extension uses, rather than a parallel implementation of them.
export { bareModelKey, evictThenPreload, healIfEvicted, isResident, matchesModelKey };
