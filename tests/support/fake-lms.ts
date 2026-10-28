/**
 * A stateful stand-in for `lms.ts`, for unit tests of the orchestrator.
 *
 * `installFakeLms()` replaces the module with `mock.module`, so the real
 * orchestrator, sessions and config code run against a fake LM Studio and
 * nothing is spawned. Needs `--experimental-test-module-mocks` (set in the
 * npm scripts; checked on Node 22.19, 24.22 and 26.12, where it is still
 * accepted). `namedExports` is deprecated on 24+ in favour of `exports`, which
 * 22.19 does not have, so it stays until the floor moves; the only cost is a
 * DeprecationWarning on newer Node. The fake reproduces the behaviour that matters here, measured
 * on a live LM Studio: loading a key that is already resident adds a second
 * copy `<key>:2` instead of failing or doing nothing.
 *
 * Sets `PI_CODING_AGENT_DIR` to a throwaway directory before the library is
 * imported, like the integration harness, so claims and locks never touch the
 * real agent dir. Call `fake.cleanup()` from an `after()` hook.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { LoadedModel } from "../../extensions/lib/lms.ts";

const LIB = path.resolve(import.meta.dirname, "../../extensions/lib");
const lib = (name: string) => pathToFileURL(path.join(LIB, name)).href;

export interface FakeLms {
	/** What `lms ps` lists. Tests set it directly. */
	loaded: LoadedModel[];
	/** Every call, as the `lms` arguments: ["unload", id], ["load", key, …], ["server", "start"]. */
	calls: string[][];
	/** When true, `unload` and `unloadAll` fail and remove nothing. */
	failUnload: boolean;
	/** Runs after a failed unload, to model the copy going away by itself. */
	afterFailedUnload?: () => void;
	/** When false, a load exits non-zero and adds nothing. */
	loadOk: boolean;
	/**
	 * Context a successful load reports, as a function of the requested one.
	 * Default: the requested value (or 4096, LM Studio's default, with none).
	 */
	contextAfterLoad?: (requested: number | undefined) => number;
	/** `lastUsedTime` of a freshly loaded copy. Default: set, as on LM Studio 0.4.x once the load is done. */
	lastUsedAfterLoad?: number | null;
	/** What `lms server status` reports. */
	serverRunning: boolean;
	/**
	 * Result of each `lms server start`, consumed in order (an empty queue
	 * means failure). A start that returns true brings the server up; one that
	 * returns false can still bring it up with `comesUpOnFailure`.
	 */
	startResults: boolean[];
	comesUpOnFailure: boolean;
	/** Remove the throwaway agent dir. */
	cleanup(): void;
	/** Reset state between tests: copies, calls, claims, switches. */
	reset(loaded?: LoadedModel[]): void;
	/** Load calls only. */
	loadCalls(): string[][];
	/** Copies of `modelKey` in the fake, as `identifier@contextLength`. */
	copiesOf(modelKey: string): string[];
}

export interface Installed {
	fake: FakeLms;
	orchestrator: typeof import("../../extensions/lib/orchestrator.ts");
	sessions: typeof import("../../extensions/lib/sessions.ts");
	config: typeof import("../../extensions/lib/config.ts");
}

/** A finished copy. `lastUsedTime` is set, which is what lets `hasWrongContext` judge it. */
export function copy(identifier: string, contextLength: number, modelKey = identifier.replace(/:\d+$/, "")): LoadedModel {
	return {
		identifier,
		modelKey,
		contextLength,
		maxContextLength: 262_144,
		lastUsedTime: 1_700_000_000_000,
		status: "idle",
	};
}

export async function installFakeLms(): Promise<Installed> {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fake-lms-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const matches = (entry: LoadedModel, key: string) =>
		entry.modelKey === key || entry.identifier === key || entry.identifier.startsWith(`${key}:`);

	const fake: FakeLms = {
		loaded: [],
		calls: [],
		failUnload: false,
		loadOk: true,
		serverRunning: false,
		startResults: [],
		comesUpOnFailure: false,
		cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }),
		reset: (loaded = []) => {
			fake.loaded = loaded.map((entry) => ({ ...entry }));
			fake.calls = [];
			fake.failUnload = false;
			fake.afterFailedUnload = undefined;
			fake.loadOk = true;
			fake.contextAfterLoad = undefined;
			fake.lastUsedAfterLoad = undefined;
			fake.serverRunning = false;
			fake.startResults = [];
			fake.comesUpOnFailure = false;
			fs.rmSync(path.join(agentDir, "extensions"), { recursive: true, force: true });
		},
		loadCalls: () => fake.calls.filter((call) => call[0] === "load"),
		copiesOf: (key) =>
			fake.loaded.filter((entry) => matches(entry, key)).map((e) => `${e.identifier}@${e.contextLength}`),
	};

	mock.module(lib("lms.ts"), {
		namedExports: {
			listLoaded: async () => fake.loaded.map((entry) => ({ ...entry })),
			serverStatus: async () => ({ running: fake.serverRunning, port: 1234 }),
			startServer: async () => {
				fake.calls.push(["server", "start"]);
				const ok = fake.startResults.shift() ?? false;
				if (ok || fake.comesUpOnFailure) fake.serverRunning = true;
				return ok;
			},
			stopServer: async () => true,
			unload: async (identifier: string) => {
				fake.calls.push(["unload", identifier]);
				if (fake.failUnload) {
					fake.afterFailedUnload?.();
					return false;
				}
				fake.loaded = fake.loaded.filter((entry) => entry.identifier !== identifier);
				return true;
			},
			unloadAll: async () => {
				fake.calls.push(["unload", "--all"]);
				if (fake.failUnload) {
					fake.afterFailedUnload?.();
					return false;
				}
				fake.loaded = [];
				return true;
			},
			lmsBackground: async (args: string[]) => {
				fake.calls.push([...args]);
				if (!fake.loadOk) return false;
				const key = args[1];
				const flag = args.indexOf("--context-length");
				const requested = flag >= 0 ? Number(args[flag + 1]) : undefined;
				const context = fake.contextAfterLoad ? fake.contextAfterLoad(requested) : (requested ?? 4096);
				const existing = fake.loaded.filter((entry) => matches(entry, key)).length;
				const fresh = copy(existing === 0 ? key : `${key}:${existing + 1}`, context, key);
				if (fake.lastUsedAfterLoad !== undefined) fresh.lastUsedTime = fake.lastUsedAfterLoad;
				fake.loaded.push(fresh);
				return true;
			},
		},
	});

	return {
		fake,
		orchestrator: await import(lib("orchestrator.ts")),
		sessions: await import(lib("sessions.ts")),
		config: await import(lib("config.ts")),
	};
}
