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
}

/** Applied wherever the config file leaves a field out. */
export const DEFAULTS: Required<Omit<EvictConfig, "ttlSeconds">> = {
	healEvictions: true,
	multiSessionSafety: true,
	autoRegisterModels: true,
	useMemoryEstimate: true,
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
 * Arguments for `lms load`. `--yes` keeps an ambiguous model key from
 * dropping `lms` into its interactive picker, which would hang a child with
 * ignored stdio. `--ttl` only when the user configured one; without it the
 * model is pinned, and its lifetime is managed by switch events rather than
 * idle time.
 *
 * The TTL is read fresh on every call, so a change made in the picker
 * applies to the next load without a reload.
 */
export function loadArgs(modelKey: string, config: EvictConfig = loadConfig()): string[] {
	const args = ["load", modelKey, "--yes"];
	const ttl = config.ttlSeconds;
	if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) {
		args.push("--ttl", String(Math.floor(ttl)));
	}
	return args;
}
