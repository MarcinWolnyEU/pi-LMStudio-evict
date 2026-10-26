/**
 * A headless stand-in for a pi session.
 *
 * Loads `extensions/evict.ts` through **pi's own jiti loader**, hands it a
 * stub `ExtensionAPI`, and then drives the captured event handlers through a
 * scripted sequence of operations. Two of these run concurrently against one
 * real LM Studio to test multi-session behaviour.
 *
 * What this covers that calling `lib/` functions directly does not: the real
 * extension entry point, its guards, its claim bookkeeping, its floating
 * background eviction task, and the real cross-process lock — in a genuine
 * second OS process. What it does not cover is the terminal renderer, which
 * is not what can corrupt LM Studio's memory.
 *
 * Not named `*.test.ts` so the runner does not pick it up as a suite.
 *
 * Usage: app-child.ts <label> <logPath> <scriptJsonPath>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { listLoaded } from "../../extensions/lib/lms.ts";
import { waitFor as barrierWait, signal } from "./barrier.ts";
import { EventLog } from "./event-log.ts";
import { findJitiEntry } from "./find-pi.ts";

/** One scripted step. */
export type AppOp =
	/** `model`: the model the process starts on, as with `pi --model`. */
	| { op: "session_start"; reason?: string; model?: string }
	| { op: "model_select"; model: string; source?: string; previous?: string }
	| { op: "turn"; prompt?: string }
	| { op: "session_shutdown"; reason?: string }
	| { op: "signal"; name: string }
	| { op: "wait"; name: string; timeoutMs?: number }
	| { op: "sleep"; ms: number }
	| { op: "snapshot"; label?: string };

const [label, logPath, scriptPath] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8")) as AppOp[];
const barrierDir = path.join(path.dirname(logPath), "barriers");
const log = new EventLog(logPath);

/**
 * Stand in for whatever normally keeps a pi process alive — its TUI holding
 * stdin open, or an in-flight agent turn. Without it Node exits the moment
 * the event loop empties, which happens constantly here because the
 * extension's `lms` children are detached and unref'd on purpose. Cleared
 * once the script finishes so the process can exit on its own.
 */
const keepAlive = setInterval(() => {}, 1000);

const jitiEntry = findJitiEntry();
if (!jitiEntry) {
	console.log(JSON.stringify({ label, error: "pi is not installed; cannot load the extension" }));
	process.exit(3);
}

// ---------------------------------------------------------------------------
// Stub ExtensionAPI / ExtensionContext
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler[]>();
const commands: string[] = [];
const notifications: string[] = [];

/**
 * The extension reports progress through `ui.setStatus`, and clears it when
 * its floating eviction task finishes. That transition is the only
 * completion signal the task exposes, so it is what we wait on.
 */
let currentStatus: string | undefined;
let statusSetSinceMark = false;
let clearWaiters: (() => void)[] = [];

const ui = {
	setStatus(_key: string, text: string | undefined) {
		currentStatus = text;
		if (text === undefined) {
			const waiters = clearWaiters;
			clearWaiters = [];
			for (const resolve of waiters) resolve();
		} else {
			statusSetSinceMark = true;
		}
	},
	notify(message: string, level = "info") {
		notifications.push(`[${level}] ${message}`);
		log.note(label, `notify: ${message}`);
	},
	// Nothing here drives the picker, but the extension holds references.
	theme: { fg: (_name: string, text: string) => text },
	async select() {
		return undefined;
	},
	async input() {
		return undefined;
	},
	async confirm() {
		return false;
	},
	setWidget() {},
	setWorkingMessage() {},
};

/** Current model, mutated by `model_select` the way pi would. */
let activeModel: { provider: string; id: string } | undefined;

const ctx = {
	ui,
	mode: "print",
	hasUI: false,
	cwd: process.cwd(),
	get model() {
		return activeModel;
	},
	isIdle: () => true,
	modelRegistry: {
		async refresh() {
			return { ok: true };
		},
	},
	sessionManager: {},
	scopedModels: [],
	signal: undefined,
	getContextUsage: () => undefined,
};

const pi = {
	on(event: string, handler: Handler) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerCommand(name: string) {
		commands.push(name);
	},
	registerTool() {},
	addKeybinding() {},
};

// ---------------------------------------------------------------------------
// Load the real extension through pi's real loader
// ---------------------------------------------------------------------------

const { createJiti } = await import(pathToFileURL(jitiEntry).href);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const entry = path.resolve(import.meta.dirname, "../../extensions/evict.ts");
const module = await jiti.import(entry);
const factory = (module.default ?? module) as (api: unknown) => void;
factory(pi);

async function emit(event: string, payload: Record<string, unknown>): Promise<void> {
	for (const handler of handlers.get(event) ?? []) {
		await handler({ type: event, ...payload }, ctx);
	}
}

/**
 * Wait for the floating eviction task to settle.
 *
 * It is deliberately not awaited by the `model_select` handler — pi must not
 * block on a model load — so the only way to know it finished is to watch
 * the footer status go back to undefined. If no status appears within
 * `graceMs`, one of the extension's guards skipped the work and there is
 * nothing to wait for.
 */
async function waitForSettled(graceMs = 4_000, maxMs = 10 * 60_000): Promise<string> {
	statusSetSinceMark = false;
	const started = Date.now();
	while (!statusSetSinceMark && Date.now() - started < graceMs) {
		if (currentStatus !== undefined) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (!statusSetSinceMark && currentStatus === undefined) return "no-op";

	// The timer is deliberately *referenced*, and cleared as soon as the race
	// settles. Without it this process exits mid-wait: the extension's
	// eviction task spends most of its life awaiting a `lms` child that is
	// detached and unref'd on purpose, so nothing holds the event loop open.
	// Real pi survives this because its TUI keeps stdin open; a headless
	// harness has to keep itself alive.
	let timer: NodeJS.Timeout | undefined;
	const cleared = new Promise<void>((resolve) => clearWaiters.push(resolve));
	const timedOut = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), maxMs);
	});
	try {
		return await Promise.race([cleared.then(() => "settled" as const), timedOut]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function residentKeys(): Promise<string[]> {
	const loaded = (await listLoaded()) ?? [];
	return loaded.map((m) => m.modelKey ?? m.identifier).sort();
}

// ---------------------------------------------------------------------------
// Run the script
// ---------------------------------------------------------------------------

const timeline: Record<string, unknown>[] = [];

for (const [index, step] of script.entries()) {
	const started = Date.now();
	log.note(label, `op ${index} ${step.op}`);
	let detail: Record<string, unknown> = {};

	switch (step.op) {
		case "session_start":
			if (step.model) activeModel = { provider: "lmstudio", id: step.model };
			await emit("session_start", { reason: step.reason ?? "startup" });
			// Starting on a model may kick off a background preload.
			if (step.model) detail.settled = await waitForSettled();
			break;

		case "model_select": {
			const previous = step.previous ?? activeModel?.id;
			activeModel = { provider: "lmstudio", id: step.model };
			log.enter(label, `select ${step.model}`);
			await emit("model_select", {
				model: activeModel,
				previousModel: previous ? { provider: "lmstudio", id: previous } : undefined,
				source: step.source ?? "set",
			});
			detail.settled = await waitForSettled();
			log.exit(label, `select ${step.model}`);
			break;
		}

		case "turn": {
			log.enter(label, "turn");
			await emit("before_agent_start", {
				prompt: step.prompt ?? "hello",
				systemPrompt: "",
				systemPromptOptions: {},
			});
			log.exit(label, "turn");
			break;
		}

		case "session_shutdown":
			await emit("session_shutdown", { reason: step.reason ?? "quit" });
			break;

		case "signal":
			signal(barrierDir, step.name);
			break;

		case "wait":
			barrierWait(barrierDir, step.name, step.timeoutMs ?? 10 * 60_000);
			break;

		case "sleep":
			await new Promise((resolve) => setTimeout(resolve, step.ms));
			break;

		case "snapshot":
			detail = { label: step.label, resident: await residentKeys() };
			break;
	}

	timeline.push({ index, op: step.op, ms: Date.now() - started, ...detail });
}

log.close();
const finalResident = await residentKeys();
clearInterval(keepAlive);
console.log(
	JSON.stringify({
		label,
		pid: process.pid,
		hooks: [...handlers.keys()],
		commands,
		notifications,
		timeline,
		resident: finalResident,
	}),
);
