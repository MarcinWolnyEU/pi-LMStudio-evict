/**
 * Thin wrappers around the `lms` CLI, plus the pure parsers for the bits of
 * its output that are not JSON.
 *
 * Everything here resolves rather than rejects: a missing `lms`, a stopped
 * LM Studio server, or a malformed payload all come back as `undefined` /
 * `false`. Callers decide whether that is worth telling the user about —
 * the automatic paths stay silent, the command surfaces errors.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Entry of `lms ps --json` — a model currently resident in memory. */
export interface LoadedModel {
	/** API identifier. Equals `modelKey` unless loaded with `--identifier`. */
	identifier: string;
	modelKey?: string;
	type?: string;
	displayName?: string;
	publisher?: string;
	sizeBytes?: number;
	/** Milliseconds of idle left before auto-unload; null when pinned. */
	ttlMs?: number | null;
	contextLength?: number;
	maxContextLength?: number;
	/** Epoch ms of the last request served; null until the model is first used. */
	lastUsedTime?: number | null;
	paramsString?: string;
	architecture?: string;
	quantization?: { name?: string; bits?: number };
	vision?: boolean;
	trainedForToolUse?: boolean;
	/** "idle" when ready for inference. Presence in the array is the load signal. */
	status?: string;
}

/** Entry of `lms ls --json` — a model present on disk. */
export interface CatalogModel {
	modelKey: string;
	/** "llm" | "embedding" | … — embeddings are filtered out of chat listings. */
	type: string;
	displayName?: string;
	publisher?: string;
	sizeBytes?: number;
	paramsString?: string;
	architecture?: string;
	quantization?: { name?: string; bits?: number };
	vision?: boolean;
	trainedForToolUse?: boolean;
	maxContextLength?: number;
}

/** Parsed `lms load --estimate-only` output. */
export interface MemoryEstimate {
	/** Total memory LM Studio expects the load to cost, in bytes. */
	totalBytes?: number;
	/** Of which, VRAM. Equals `totalBytes` on a full GPU offload. */
	vramBytes?: number;
	/** LM Studio's own confidence in the estimate ("LOW" | "MEDIUM" | "HIGH"). */
	confidence?: string;
	/** LM Studio's verdict against the user's resource guardrails. */
	passesGuardrails?: boolean;
}

/** `lms server status --json`. */
export interface ServerStatus {
	running: boolean;
	port?: number;
}

/**
 * Where to find `lms`: `LMS_PATH`, then `PATH`, then LM Studio's own install
 * location (`~/.lmstudio/bin`).
 *
 * The last step is the one that matters on macOS. LM Studio adds that
 * directory to the *login shell's* profile, so a pi started from a GUI
 * launcher, an IDE, or a non-login shell has no `lms` on `PATH`, and every
 * automatic path here would silently do nothing.
 *
 * Resolved once per process: none of these move while pi runs.
 */
let resolvedLms: string | undefined;

export function lmsBinary(): string {
	if (resolvedLms) return resolvedLms;
	const exe = process.platform === "win32" ? "lms.exe" : "lms";
	const candidates = [
		process.env.LMS_PATH,
		...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, exe)),
		path.join(os.homedir(), ".lmstudio", "bin", exe),
	];
	const found = candidates.find((candidate) => {
		if (!candidate) return false;
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
	// Fall back to the bare name: spawn then fails the same way it always did.
	resolvedLms = found ?? "lms";
	return resolvedLms;
}

const JSON_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 60_000;
/** The estimate is a local calculation; it returns in well under a second. */
const ESTIMATE_TIMEOUT_MS = 30_000;

/** Run `lms` and parse its JSON stdout. Resolves undefined on any failure. */
export function lmsJson<T>(args: string[], timeoutMs = JSON_TIMEOUT_MS): Promise<T | undefined> {
	return new Promise((resolve) => {
		execFile(lmsBinary(), args, { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
			if (error) return resolve(undefined);
			try {
				resolve(JSON.parse(stdout) as T);
			} catch {
				resolve(undefined);
			}
		});
	});
}

/**
 * Run `lms` for its human-readable output, resolving undefined when the
 * command fails.
 *
 * Both streams are concatenated because `lms` is inconsistent about which
 * one it uses: `--estimate-only`, for instance, prints its whole report to
 * stderr and leaves stdout empty. Callers here only parse, never re-emit,
 * so the merge costs nothing.
 */
export function lmsText(args: string[], timeoutMs = RUN_TIMEOUT_MS): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(lmsBinary(), args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
			resolve(error ? undefined : `${stdout}\n${stderr}`);
		});
	});
}

/** Run `lms` for its side effect; resolves true when it exits cleanly. */
export function lmsRun(args: string[], timeoutMs = RUN_TIMEOUT_MS): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(lmsBinary(), args, { windowsHide: true, timeout: timeoutMs }, (error) => resolve(!error));
	});
}

export interface BackgroundOptions {
	/**
	 * Keep the calling process alive until the command finishes.
	 *
	 * Off by default: a fire-and-forget load must never stop pi from
	 * quitting. **On for any caller that awaits the result and acts on it** —
	 * without it Node is free to exit the moment the event loop empties, and
	 * an unref'd child is not a reason to stay. That is not hypothetical: the
	 * heal path awaits a load, and in a host without a TUI holding stdin open
	 * the process exited mid-load with "unsettled top-level await".
	 */
	keepAlive?: boolean;
}

/**
 * Detached `lms` invocation for commands with no useful output and no
 * bounded runtime — model loads legitimately take minutes, and a timeout
 * would kill one mid-flight.
 *
 * `detached` means the load survives pi exiting either way; `keepAlive`
 * decides whether pi *waits* for it.
 */
export function lmsBackground(args: string[], options: BackgroundOptions = {}): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		try {
			const child = spawn(lmsBinary(), args, { stdio: "ignore", windowsHide: true, detached: true });
			child.on("error", () => settle(false)); // lms not on PATH, server down, …
			child.once("exit", (code) => settle(code === 0));
			// An un-unref'd child handle is itself what holds the loop open.
			if (!options.keepAlive) child.unref();
		} catch {
			// spawn can throw synchronously when the binary is missing.
			settle(false);
		}
	});
}

/** Models currently in memory. Undefined means `lms` could not be reached. */
export function listLoaded(): Promise<LoadedModel[] | undefined> {
	return lmsJson<LoadedModel[]>(["ps", "--json"]);
}

/** Models on disk. Undefined means `lms` could not be reached. */
export function listCatalog(): Promise<CatalogModel[] | undefined> {
	return lmsJson<CatalogModel[]>(["ls", "--json"]);
}

/** Local server state, including the port it listens on. */
export function serverStatus(): Promise<ServerStatus | undefined> {
	return lmsJson<ServerStatus>(["server", "status", "--json"]);
}

/** Unload one model by its `lms ps` identifier. */
export function unload(identifier: string): Promise<boolean> {
	return lmsRun(["unload", identifier]);
}

/** Unload every resident model, no exceptions. */
export function unloadAll(): Promise<boolean> {
	return lmsRun(["unload", "--all"]);
}

/**
 * Built with `new RegExp` from escape sequences on purpose: the literal
 * characters involved (ESC, non-breaking/thin/narrow spaces) are invisible
 * in an editor and get mangled by well-meaning tooling.
 */
/** CSI SGR colour sequences, stripped before parsing. */
const ANSI = new RegExp("\u001b\\[[0-9;]*m", "g");
/**
 * Digit-group separators lms may emit inside a number: plain space,
 * non-breaking (U+00A0), thin (U+2009), narrow no-break (U+202F).
 */
const SEPARATOR_CLASS = "\\s\u00a0\u2009\u202f";
const GROUP_SEPARATORS = new RegExp("[" + SEPARATOR_CLASS + "]", "g");
/** "17.35 GiB", "1 024 MiB", "512 B" — value then unit. */
const SIZE_PATTERN = new RegExp("^([\\d" + SEPARATOR_CLASS + ".,]+?)\\s*([KMGT]i?B|B)$", "i");

const UNIT_BYTES: Record<string, number> = {
	B: 1,
	KIB: 1024,
	MIB: 1024 ** 2,
	GIB: 1024 ** 3,
	TIB: 1024 ** 4,
	// lms formats with base-1024 units, but accept decimal spellings too so a
	// future formatting change degrades to a slightly-off number, not to nothing.
	KB: 1000,
	MB: 1000 ** 2,
	GB: 1000 ** 3,
	TB: 1000 ** 4,
};

/**
 * Parse one `lms`-formatted size ("17.35 GiB", "1 024 MiB") into bytes.
 * Returns undefined when the text is not a size.
 */
export function parseSizeBytes(text: string): number | undefined {
	const match = text.replace(ANSI, "").trim().match(SIZE_PATTERN);
	if (!match) return undefined;
	const value = Number.parseFloat(match[1].replace(GROUP_SEPARATORS, "").replace(",", "."));
	const unit = UNIT_BYTES[match[2].toUpperCase()];
	if (!Number.isFinite(value) || unit === undefined) return undefined;
	return value * unit;
}

/**
 * Parse `lms load --estimate-only` output. The command prints a small
 * human-readable block rather than JSON:
 *
 *     Model: qwen3-coder-30b-a3b-instruct
 *     Estimated GPU Memory:   17.35 GiB
 *     Estimated Total Memory: 17.35 GiB
 *     Confidence: LOW
 *
 *     Estimate: This model may be loaded based on your resource guardrails settings.
 *
 * Every field is optional: LM Studio omits lines it has nothing to say about,
 * so a partial parse is a normal result, not an error.
 */
export function parseEstimate(stdout: string): MemoryEstimate {
	const estimate: MemoryEstimate = {};
	for (const rawLine of stdout.replace(ANSI, "").split(/\r?\n/)) {
		const [label, ...rest] = rawLine.trim().split(":");
		const value = rest.join(":").trim();
		switch (label.trim().toLowerCase()) {
			case "estimated total memory":
				estimate.totalBytes = parseSizeBytes(value);
				break;
			case "estimated gpu memory":
				estimate.vramBytes = parseSizeBytes(value);
				break;
			case "confidence":
				if (value) estimate.confidence = value.toUpperCase();
				break;
			case "estimate":
				// Exactly two verdicts exist, keyed on `estimate.passesGuardrails`.
				if (/will fail to load/i.test(value)) estimate.passesGuardrails = false;
				else if (/may be loaded/i.test(value)) estimate.passesGuardrails = true;
				break;
		}
	}
	return estimate;
}

/**
 * Ask LM Studio what loading `modelKey` would actually cost. This accounts
 * for the runtime's own overhead, which raw file size does not, and applies
 * the user's resource guardrails.
 *
 * Resolves undefined when `lms` is unreachable, and an empty object when the
 * output parsed to nothing useful.
 */
export async function estimateMemory(
	modelKey: string,
	contextLength?: number,
): Promise<MemoryEstimate | undefined> {
	const args = ["load", modelKey, "--estimate-only", "--yes"];
	if (typeof contextLength === "number" && contextLength > 0) {
		args.push("--context-length", String(contextLength));
	}
	const stdout = await lmsText(args, ESTIMATE_TIMEOUT_MS);
	if (stdout === undefined) return undefined;
	return parseEstimate(stdout);
}
