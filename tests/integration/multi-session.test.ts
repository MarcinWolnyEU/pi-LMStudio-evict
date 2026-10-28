/**
 * Multi-session behaviour, driven through the real extension entry point in
 * two concurrent OS processes.
 *
 * Every other test in this suite calls `lib/` functions directly, which
 * skips the part most likely to break: `extensions/evict.ts` itself — its
 * guards, its claim bookkeeping, and the floating background task it starts
 * on `model_select` and deliberately does not await.
 *
 * `tests/support/app-child.ts` closes that gap. It loads the extension
 * through pi's own jiti loader, hands it a stub `ExtensionAPI`, and replays a
 * scripted sequence of events. Two children run against one real LM Studio
 * with a shared `PI_CODING_AGENT_DIR`, so the lock, the claim files and the
 * `lms` calls are all genuine. The only thing not exercised is the terminal
 * renderer, which is not what can corrupt LM Studio's memory.
 *
 * Barriers (rather than sleeps) synchronise the two children, so the
 * simultaneous-switch case is reproduced exactly instead of approximately.
 */

import {
	LONG_TIMEOUT_MS,
	cleanupAgentDir,
	preflight,
	printTimingReport,
	residentIdentifiers,
	residentKeys,
	resetLmStudio,
	timed,
} from "./harness.ts";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../../extensions/lib/config.ts";
import { lmsRun, unloadAll } from "../../extensions/lib/lms.ts";
import { sessionsDir } from "../../extensions/lib/sessions.ts";
import { resetBarriers, signal } from "../support/barrier.ts";
import { analyse } from "../support/event-log.ts";
import { findJitiEntry } from "../support/find-pi.ts";

const CHILD = fileURLToPath(new URL("../support/app-child.ts", import.meta.url));

interface ChildReport {
	label: string;
	pid?: number;
	hooks?: string[];
	commands?: string[];
	notifications?: string[];
	timeline?: { index: number; op: string; ms: number; settled?: string; resident?: string[] }[];
	resident?: string[];
	error?: string;
}

interface TrackedChild {
	child: ReturnType<typeof spawn>;
	closed: Promise<void>;
	running: boolean;
}

interface Workspace {
	dir: string;
	log: string;
	barriers: string;
	/**
	 * Children belong to the workspace that spawned them. Cleanup must never
	 * reach across workspaces: a global "kill everything after 5s" reaped the
	 * *next* test's children and failed two tests at exactly 5023ms.
	 */
	children: TrackedChild[];
}

let counter = 0;
const workspaces: Workspace[] = [];

function workspace(): Workspace {
	const dir = path.join(os.tmpdir(), `pi-lmstudio-evict-app-${process.pid}-${counter++}`);
	const barriers = path.join(dir, "barriers");
	fs.mkdirSync(barriers, { recursive: true });
	resetBarriers(barriers);
	const ws: Workspace = { dir, log: path.join(dir, "events.log"), barriers, children: [] };
	workspaces.push(ws);
	return ws;
}

function killChildren(ws: Workspace): void {
	for (const tracked of ws.children) {
		if (tracked.running) tracked.child.kill("SIGKILL");
	}
}

function runChild(label: string, ws: Workspace, script: unknown[]): Promise<ChildReport> {
	const scriptPath = path.join(ws.dir, `${label}.json`);
	fs.writeFileSync(scriptPath, JSON.stringify(script), "utf-8");
	const report = startChild(label, ws, scriptPath);
	// The caller awaits this later, after synchronising on a barrier. Until
	// then an early rejection would surface as an *unhandled* rejection,
	// which node:test reports against whatever test happens to be running
	// while the real body carries on waiting — a confusing 15-minute hang.
	report.catch(() => {});
	return report;
}

function startChild(label: string, ws: Workspace, scriptPath: string): Promise<ChildReport> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD, label, ws.log, scriptPath], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			// The shared agent dir is what makes these genuinely one "machine".
			env: { ...process.env, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR },
		});
		const tracked: TrackedChild = {
			child,
			running: true,
			closed: new Promise<void>((done) => child.once("close", () => done())),
		};
		ws.children.push(tracked);

		let out = "";
		let err = "";
		child.stdout.on("data", (c) => {
			out += c;
		});
		child.stderr.on("data", (c) => {
			err += c;
		});
		child.once("error", (error) => {
			tracked.running = false;
			reject(error);
		});
		child.once("close", (code) => {
			tracked.running = false;
			const line = out.trim().split(/\r?\n/).pop() ?? "";
			try {
				resolve(JSON.parse(line) as ChildReport);
			} catch {
				reject(new Error(`${label} exited ${code} without a report.\nstdout: ${out}\nstderr: ${err}`));
			}
		});
	});
}

/**
 * Release this workspace's parked children and reap anything left.
 *
 * Registered with `t.after`, so it runs whether the test passed or threw —
 * without it, a failed assertion strands a child on a barrier, and the live
 * spawn handle then keeps the whole runner alive so the failure message is
 * never even printed.
 */
async function releaseAll(ws: Workspace): Promise<void> {
	signal(ws.barriers, "parent.release");
	signal(ws.barriers, "go");
	const allClosed = Promise.all(ws.children.map((c) => c.closed));
	const grace = new Promise<void>((resolve) => {
		setTimeout(resolve, 20_000).unref?.();
	});
	await Promise.race([allClosed, grace]);
	killChildren(ws);
}

/**
 * Block until a child raises `name`, so assertions land at a known point.
 *
 * Fails fast when a child dies first. Waiting out the full timeout instead
 * turns a crashed child into a 15-minute hang whose real cause has already
 * scrolled past.
 */
async function awaitBarrier(ws: Workspace, name: string, timeoutMs = 5 * 60_000): Promise<void> {
	const target = path.join(ws.barriers, name);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(target)) {
		if (ws.children.some((c) => !c.running)) {
			throw new Error(`a child exited before raising barrier "${name}"`);
		}
		if (Date.now() > deadline) throw new Error(`barrier "${name}" never appeared`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function claimFiles(): string[] {
	try {
		return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
}

after(() => {
	for (const ws of workspaces) killChildren(ws);
	printTimingReport("Headless multi-session timings");
	cleanupAgentDir();
});

test("app-child: the harness loads the real extension", { timeout: 120_000 }, async (t) => {
	if (!findJitiEntry()) {
		t.diagnostic("pi is not installed here; the headless harness cannot load the extension");
		t.skip("pi not installed");
		return;
	}
	const ws = workspace();
	const report = await timed(t, "load extension in a child process", () =>
		runChild("probe", ws, [{ op: "snapshot", label: "idle" }]),
	);

	t.diagnostic(`hooks: ${report.hooks?.join(", ")}`);
	t.diagnostic(`commands: ${report.commands?.join(", ")}`);
	assert.deepEqual(
		report.hooks?.sort(),
		["before_agent_start", "model_select", "session_shutdown", "session_start"],
		"the child must register the same hooks pi would",
	);
	assert.deepEqual(report.commands, [
		"lmstudio-evict-model",
		"llm-evict-model",
		"model-load-unload",
		"llm-load-unload",
	]);
});

test(
	"two sessions: a live claim from another process is spared",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		if (!findJitiEntry()) return t.skip("pi not installed");
		const { small } = await preflight();
		const [x, y] = [small[0].modelKey, small[1].modelKey];
		await resetLmStudio();
		const ws = workspace();
		t.after(() => releaseAll(ws));

		// A settles on X first; B then switches to Y and must spare X.
		const a = runChild("A", ws, [
			{ op: "session_start" },
			{ op: "model_select", model: x },
			{ op: "signal", name: "a.ready" },
			{ op: "wait", name: "parent.release" },
			{ op: "session_shutdown" },
		]);
		const b = runChild("B", ws, [
			{ op: "session_start" },
			{ op: "wait", name: "a.ready" },
			{ op: "model_select", model: y },
			{ op: "signal", name: "b.ready" },
			{ op: "wait", name: "parent.release" },
			{ op: "session_shutdown" },
		]);

		await timed(t, `A loads ${x}, then B loads ${y}`, () => awaitBarrier(ws, "b.ready"));

		// Assert while both processes are still alive and still claiming.
		const resident = await residentKeys();
		const claims = claimFiles();
		t.diagnostic(`resident: ${resident.join(", ")}`);
		t.diagnostic(`claim files: ${claims.join(", ")}`);
		assert.deepEqual(resident, [x, y].sort(), `${x} should have been spared for session A`);
		assert.equal(claims.length, 2, "both live sessions should have a claim on disk");

		signal(ws.barriers, "parent.release");
		const [reportA, reportB] = await Promise.all([a, b]);
		assert.equal(reportA.error, undefined);
		assert.equal(reportB.error, undefined);

		// Both quit cleanly, so both claims must be gone.
		assert.deepEqual(claimFiles(), [], "session_shutdown should drop every claim");
	},
);

test(
	"two sessions switching to the same model at once never load it twice",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		if (!findJitiEntry()) return t.skip("pi not installed");
		const { small } = await preflight();
		const [x, y] = [small[0].modelKey, small[1].modelKey];
		await resetLmStudio();
		const ws = workspace();
		t.after(() => releaseAll(ws));

		// Both sessions start on X, then switch to Y at the same instant.
		// Without the cross-process lock this is two concurrent `lms load y`
		// calls, and LM Studio answers that with a second copy under "y:2".
		const script = (label: string) => [
			{ op: "session_start" },
			{ op: "model_select", model: x },
			{ op: "signal", name: `${label}.on-x` },
			{ op: "wait", name: "go" },
			{ op: "model_select", model: y },
			{ op: "signal", name: `${label}.done` },
			{ op: "wait", name: "parent.release" },
			{ op: "session_shutdown" },
		];

		const a = runChild("A", ws, script("a"));
		const b = runChild("B", ws, script("b"));

		await timed(t, `both sessions settle on ${x}`, async () => {
			await awaitBarrier(ws, "a.on-x");
			await awaitBarrier(ws, "b.on-x");
		});

		await timed(t, `both switch to ${y} simultaneously`, async () => {
			signal(ws.barriers, "go");
			await awaitBarrier(ws, "a.done");
			await awaitBarrier(ws, "b.done");
		});

		const identifiers = await residentIdentifiers();
		t.diagnostic(`resident identifiers: ${identifiers.join(", ")}`);
		const duplicates = identifiers.filter((id) => /:\d+$/.test(id));
		assert.deepEqual(
			duplicates,
			[],
			`a ":n" identifier means two concurrent loads got through the lock (${identifiers.join(", ")})`,
		);
		assert.ok(identifiers.includes(y), `${y} should be resident`);

		signal(ws.barriers, "parent.release");
		await Promise.all([a, b]);

		// The event log records each session's model_select as ENTER/EXIT.
		// Overlap here is expected and fine — the two sessions are allowed to
		// switch concurrently; what must not happen is a duplicate load.
		const analysis = analyse(ws.log);
		t.diagnostic(`event log: ${analysis.enters} enters, ${analysis.exits} exits`);
		assert.equal(analysis.enters, analysis.exits, "every switch should have completed");
	},
);

test(
	"heal fires through the real entry point once the residency cache expires",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		if (!findJitiEntry()) return t.skip("pi not installed");
		const { small } = await preflight();
		const target = small[0].modelKey;
		await resetLmStudio();
		const ws = workspace();

		const child = runChild("A", ws, [
			{ op: "session_start" },
			{ op: "model_select", model: target },
			{ op: "signal", name: "loaded" },
			{ op: "wait", name: "evicted" },
			// Immediately after a switch the extension trusts its own
			// observation for RESIDENCY_CACHE_MS, so this turn must NOT heal.
			{ op: "turn" },
			{ op: "signal", name: "first-turn-done" },
			{ op: "wait", name: "checked" },
			// Past the cache window, the next turn must notice and reload.
			{ op: "sleep", ms: 16_000 },
			{ op: "turn" },
			{ op: "signal", name: "second-turn-done" },
			{ op: "wait", name: "parent.release" },
			{ op: "session_shutdown" },
		]);

		// Observe everything first, release the child, then assert — so a
		// failure reports the whole sequence instead of the first surprise.
		t.after(() => releaseAll(ws));

		await timed(t, `load ${target}`, () => awaitBarrier(ws, "loaded"));
		const afterLoad = await residentKeys();

		// Evict behind the extension's back, as an idle TTL or the GUI would.
		await timed(t, "external unload", () => unloadAll());
		const afterUnload = await residentKeys();
		signal(ws.barriers, "evicted");

		await timed(t, "turn inside the residency cache", () => awaitBarrier(ws, "first-turn-done"));
		const afterCachedTurn = await residentKeys();
		signal(ws.barriers, "checked");

		await timed(t, "turn after the cache expires (includes a 16s wait)", () =>
			awaitBarrier(ws, "second-turn-done"),
		);
		const afterHealTurn = await residentKeys();

		signal(ws.barriers, "parent.release");
		const report = await child;

		t.diagnostic(`after load:        ${afterLoad.join(", ") || "(empty)"}`);
		t.diagnostic(`after unload:      ${afterUnload.join(", ") || "(empty)"}`);
		t.diagnostic(`after cached turn: ${afterCachedTurn.join(", ") || "(empty)"}`);
		t.diagnostic(`after heal turn:   ${afterHealTurn.join(", ") || "(empty)"}`);
		t.diagnostic(`notifications:     ${report.notifications?.join(" | ") ?? "(none)"}`);
		for (const step of report.timeline ?? []) {
			t.diagnostic(`  op ${step.index} ${step.op}: ${step.ms}ms${step.settled ? ` (${step.settled})` : ""}`);
		}

		assert.deepEqual(afterLoad, [target], "the model should be loaded to begin with");
		assert.deepEqual(afterUnload, [], "the external unload should have emptied LM Studio");
		assert.deepEqual(
			afterCachedTurn,
			[],
			"inside the cache window the extension trusts its last observation and skips the check",
		);
		assert.deepEqual(afterHealTurn, [target], "the model should have been healed back");
		assert.ok(
			report.notifications?.some((n) => n.includes("evicted") && n.includes(target)),
			`the user should have been told the model was reloaded; got: ${report.notifications?.join(" | ")}`,
		);
	},
);

test(
	"unloadOnQuit: the last session to quit unloads the model, not the first",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		if (!findJitiEntry()) return t.skip("pi not installed");
		const { small } = await preflight();
		const target = small[0].modelKey;
		await resetLmStudio();
		// Children share this agent dir, so they read the same config.
		saveConfig({ unloadOnQuit: true });
		t.after(() => saveConfig({}));
		const ws = workspace();
		t.after(() => releaseAll(ws));

		const a = runChild("A", ws, [
			{ op: "session_start" },
			{ op: "model_select", model: target },
			{ op: "signal", name: "a.ready" },
			{ op: "wait", name: "a.quit" },
			{ op: "session_shutdown" },
		]);
		const b = runChild("B", ws, [
			{ op: "session_start" },
			{ op: "wait", name: "a.ready" },
			{ op: "model_select", model: target },
			{ op: "signal", name: "b.ready" },
			{ op: "wait", name: "b.quit" },
			{ op: "session_shutdown" },
		]);
		await timed(t, "both sessions on the same model", () => awaitBarrier(ws, "b.ready"));
		assert.deepEqual(await residentKeys(), [target]);

		signal(ws.barriers, "a.quit");
		assert.equal((await a).error, undefined);
		assert.deepEqual(await residentKeys(), [target], "B still claims it, so A's quit must spare it");

		signal(ws.barriers, "b.quit");
		assert.equal((await b).error, undefined);
		assert.deepEqual(await residentKeys(), [], "the last session out unloads it");
	},
);

test(
	"preloadOnStartup off (the default): starting on a model evicts and loads nothing",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		if (!findJitiEntry()) return t.skip("pi not installed");
		const { small } = await preflight();
		const [x, y] = [small[0].modelKey, small[1].modelKey];
		await resetLmStudio();
		saveConfig({});
		// Something another app loaded; a default startup must leave it alone.
		assert.ok(await lmsRun(["load", x, "--yes"]), "setup load failed");
		const ws = workspace();
		t.after(() => releaseAll(ws));

		const report = await timed(t, `start on ${y} with ${x} resident, default config`, () =>
			runChild("A", ws, [{ op: "session_start", model: y }, { op: "session_shutdown" }]),
		);
		assert.equal(report.error, undefined);
		assert.equal(report.timeline?.[0].settled, "no-op", "no preload should have started");
		assert.deepEqual(await residentKeys(), [x], `${x} should be untouched and ${y} not loaded`);
	},
);

test(
	"preloadOnStartup on: startup on a model (pi --model) evicts the others and preloads it; resume does not",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		if (!findJitiEntry()) return t.skip("pi not installed");
		const { small } = await preflight();
		const [x, y] = [small[0].modelKey, small[1].modelKey];
		await resetLmStudio();
		// Children share this agent dir, so they read the same config.
		saveConfig({ preloadOnStartup: true });
		t.after(() => saveConfig({}));
		const ws = workspace();
		t.after(() => releaseAll(ws));

		// pi emits no model_select for the model it starts on, so this goes
		// through session_start alone.
		await timed(t, `start on ${y} beside nothing`, () =>
			runChild("A", ws, [{ op: "session_start", model: y }, { op: "session_shutdown" }]),
		);
		assert.deepEqual(await residentKeys(), [y], "starting on a model preloads it");

		const resumed = await runChild("B", ws, [
			{ op: "session_start", model: x, reason: "resume" },
			{ op: "session_shutdown" },
		]);
		assert.equal(resumed.error, undefined);
		assert.deepEqual(await residentKeys(), [y], "a resume continues the user's state and evicts nothing");

		await timed(t, `start on ${x} with ${y} resident`, () =>
			runChild("C", ws, [{ op: "session_start", model: x }, { op: "session_shutdown" }]),
		);
		assert.deepEqual(await residentKeys(), [x], `${y} should have been evicted for ${x}`);
	},
);

test("teardown: LM Studio is left empty", { timeout: LONG_TIMEOUT_MS }, async () => {
	await resetLmStudio();
	assert.deepEqual(await residentIdentifiers(), []);
});
