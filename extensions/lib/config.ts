/**
 * Settings and the on-disk layout the extension owns.
 *
 * Everything lives under `<agentDir>/extensions/pi-lmstudio-evict/`, the
 * per-extension layout pi-subagents established:
 *
 *     config.json          the settings below
 *     lms.lock             cross-process mutex around evict/load sequences
 *     sessions/<id>.json   one claim per live pi session (see sessions.ts)
 *
 * `loadConfig()` never throws: a missing or malformed file yields defaults,
 * because a broken settings file must not break model switching.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ModelsJson, isManaged } from "./registry.ts";

export interface EvictConfig {
	/**
	 * Idle seconds after which LM Studio unloads a model this extension
	 * loaded (passed as `lms load --ttl`). Absent: models are pinned and
	 * stay loaded until the next model switch.
	 */
	ttlSeconds?: number;
	/**
	 * Re-load the active model before a turn when something unloaded it
	 * behind pi's back — an idle TTL firing, a manual unload in the GUI, or
	 * a model switch that was skipped because the agent was mid-stream.
	 */
	healEvictions?: boolean;
	/**
	 * Leave models alone when another live pi session has claimed them,
	 * instead of the blanket `lms unload --all`. Turn off to get the old
	 * behaviour back on a single-session machine.
	 */
	multiSessionSafety?: boolean;
	/**
	 * Keep the LM Studio provider block in pi's `models.json` in step with
	 * what LM Studio has on disk: add models that appear, drop the ones that
	 * disappear. Only entries this extension created are ever touched.
	 */
	autoRegisterModels?: boolean;
	/**
	 * Size models in the picker by `lms load --estimate-only` — LM Studio's
	 * own memory projection — rather than by raw file size. Costs one `lms`
	 * call per listed model, so it can be turned off on huge catalogues.
	 */
	useMemoryEstimate?: boolean;
	/**
	 * Context length to load models with (`lms load --context-length`), for
	 * models without a hand-written `contextWindow` (see `matchContextWindow`).
	 * Absent: LM Studio picks its per-model default, which is often far below
	 * what pi assumes and surfaces as "tokens to keep … greater than the
	 * context length" on the first long prompt.
	 */
	contextLength?: number;
	/**
	 * Load a model at the `contextWindow` of its hand-written `models.json`
	 * entry, so LM Studio really serves the window pi budgets for. Off by
	 * default, because it changes how existing hand-written entries load. Entries this
	 * extension generated are skipped: theirs is the model's *maximum*
	 * context, which can be 256k and more than the machine can hold.
	 */
	matchContextWindow?: boolean;
	/**
	 * Extra `lms load` flags for every load this extension performs, e.g.
	 * `["--gpu", "max", "--parallel", "2", "--speculative-draft-mtp"]` — see
	 * `lms load --help` for what your LM Studio supports. Flags the extension
	 * sets itself are dropped (see `OWNED_FLAGS`).
	 */
	extraLoadArgs?: string[];
	/** Per-model extra `lms load` flags, keyed by model key; added after `extraLoadArgs`. */
	modelLoadArgs?: Record<string, string[]>;
	/**
	 * Start LM Studio's local server (`lms server start`) when an LM Studio
	 * model is in use and the server is down. Off by default: starting a
	 * server is a bigger step than loading a model, so it is opt-in.
	 */
	startServer?: boolean;
	/**
	 * When pi quits normally, unload the model this session was using, unless
	 * another live pi session claims it. A hard kill runs no code at all; set
	 * `ttlSeconds` as the backstop for that case.
	 */
	unloadOnQuit?: boolean;
	/**
	 * When pi quits normally and no other live pi session remains, stop LM
	 * Studio's local server too. Other apps may be using it, so off by default.
	 */
	stopServerOnQuit?: boolean;
}

/** Applied wherever the config file leaves a field out. */
export const DEFAULTS: Required<
	Omit<EvictConfig, "ttlSeconds" | "contextLength" | "extraLoadArgs" | "modelLoadArgs">
> = {
	healEvictions: true,
	multiSessionSafety: true,
	autoRegisterModels: true,
	useMemoryEstimate: true,
	matchContextWindow: false,
	startServer: false,
	unloadOnQuit: false,
	stopServerOnQuit: false,
};

export type ResolvedConfig = EvictConfig & typeof DEFAULTS;

/** Config with defaults filled in, for code that just wants to read a flag. */
export function withDefaults(config: EvictConfig): ResolvedConfig {
	return { ...DEFAULTS, ...config };
}

/** Mirrors pi's own agent-dir resolution, including `~` expansion. */
export function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured === "~") return os.homedir();
	if (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
	return configured || path.join(os.homedir(), ".pi", "agent");
}

/** Directory holding this extension's config, lock, and session claims. */
export function extensionDir(): string {
	return path.join(agentDir(), "extensions", "pi-lmstudio-evict");
}

export function configPath(): string {
	return path.join(extensionDir(), "config.json");
}

/** pi's model catalogue, the file `autoRegisterModels` maintains. */
export function modelsJsonPath(): string {
	return path.join(agentDir(), "models.json");
}

/** Raw config as written on disk. Returns `{}` when absent or unreadable. */
export function loadConfig(): EvictConfig {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as EvictConfig;
	} catch {
		// Missing or malformed file — run with defaults.
		return {};
	}
}

/** Config with defaults applied. Read fresh; nothing here is cached. */
export function loadResolvedConfig(): ResolvedConfig {
	return withDefaults(loadConfig());
}

export function saveConfig(config: EvictConfig): void {
	fs.mkdirSync(extensionDir(), { recursive: true });
	fs.writeFileSync(configPath(), `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
}

/**
 * `lms load` flags the extension owns, mapped to whether they take a value.
 * A user copy would fight the extension's own: a second `--context-length`
 * defeats the wrong-context check, `--identifier` breaks residency matching
 * (and with it the `key:2` duplicate guard), `--estimate-only` loads nothing.
 */
const OWNED_FLAGS: ReadonlyMap<string, boolean> = new Map([
	["--yes", false],
	["-y", false],
	["--estimate-only", false],
	["--ttl", true],
	["--context-length", true],
	["-c", true],
	["--identifier", true],
]);

/**
 * The user's extra flags for `modelKey`, with the ones in `OWNED_FLAGS`
 * (and their values, in `--flag value`, `--flag=value` and `-c4096` form) removed.
 * Non-string entries are ignored; config is hand-editable JSON.
 */
export function extraArgsFor(modelKey: string, config: EvictConfig): string[] {
	const raw = [
		...(Array.isArray(config.extraLoadArgs) ? config.extraLoadArgs : []),
		...(Array.isArray(config.modelLoadArgs?.[modelKey]) ? config.modelLoadArgs[modelKey] : []),
	].filter((arg): arg is string => typeof arg === "string" && arg !== "");

	const kept: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const arg = raw[i];
		const flag = arg.split("=")[0];
		const takesValue = OWNED_FLAGS.get(flag);
		if (takesValue === undefined) {
			// `-c4096`: a short flag with its value attached, as commander allows.
			const short = !arg.startsWith("--") && arg.length > 2 ? arg.slice(0, 2) : undefined;
			if (!(short && OWNED_FLAGS.get(short))) kept.push(arg);
			continue;
		}
		if (takesValue && !arg.includes("=")) i++; // skip its value too
	}
	return kept;
}

/** A positive whole number of tokens, or undefined. */
function tokens(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * The context length `modelKey` should be loaded with, or undefined to leave
 * it to LM Studio. A hand-written `contextWindow` under any `lmstudio*`
 * provider wins (when `matchContextWindow` is on), then the global
 * `contextLength`.
 *
 * Read fresh from disk on every call, like the rest of the config; an
 * unreadable `models.json` just means "no per-model value".
 */
export function contextLengthFor(
	modelKey: string,
	config: EvictConfig = loadConfig(),
	modelsPath: string = modelsJsonPath(),
): number | undefined {
	if (config.matchContextWindow ?? DEFAULTS.matchContextWindow) {
		try {
			const models = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as ModelsJson;
			for (const [provider, block] of Object.entries(models?.providers ?? {})) {
				if (!provider.startsWith("lmstudio")) continue;
				const entry = block?.models?.find((m) => m?.id === modelKey && !isManaged(m));
				const window = tokens(entry?.contextWindow);
				if (window) return window;
			}
		} catch {
			// Missing or malformed models.json — fall through to the global value.
		}
	}
	return tokens(config.contextLength);
}

/**
 * Arguments for `lms load`. `--yes` keeps an ambiguous model key from
 * dropping `lms` into its interactive picker, which would hang a child with
 * ignored stdio. `--ttl` only when the user configured one; without it the
 * model is pinned, and its lifetime is managed by switch events rather than
 * idle time.
 *
 * The TTL is read fresh on every call, so a change made in the picker
 * applies to the next load without a reload. The context length is passed in
 * rather than looked up here, so this stays a pure function of its inputs;
 * callers get it from `contextLengthFor()`.
 */
export function loadArgs(
	modelKey: string,
	config: EvictConfig = loadConfig(),
	contextLength?: number,
): string[] {
	const args = ["load", modelKey, "--yes"];
	const ttl = config.ttlSeconds;
	if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) {
		args.push("--ttl", String(Math.floor(ttl)));
	}
	const context = tokens(contextLength);
	if (context) args.push("--context-length", String(context));
	args.push(...extraArgsFor(modelKey, config));
	return args;
}
