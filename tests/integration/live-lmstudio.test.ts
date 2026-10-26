/**
 * Live integration tests against a running LM Studio.
 *
 * Ordered and stateful on purpose: each test leaves LM Studio in the state
 * the next one expects, mirroring how a real session moves between models.
 * `node --test` runs top-level tests in a file sequentially, and the npm
 * script pins `--test-concurrency=1` so no other file races for the same
 * LM Studio instance.
 *
 * Requires a live LM Studio with at least two non-embedding models — see
 * harness.ts, which fails the run (rather than skipping) when that is not so.
 */

import {
	LONG_TIMEOUT_MS,
	cleanupAgentDir,
	preflight,
	printTimingReport,
	recordTiming,
	residentIdentifiers,
	residentKeys,
	resetLmStudio,
	timed,
} from "./harness.ts";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { DEFAULTS } from "../../extensions/lib/config.ts";
import {
	estimateMemory,
	listLoaded,
	lmsBinary,
	lmsRun,
	serverStatus,
	stopServer,
	unload,
} from "../../extensions/lib/lms.ts";
import { formatBytes } from "../../extensions/lib/memory.ts";
import {
	ensureServer,
	evictThenPreload,
	healIfEvicted,
	isResident,
	matchesModelKey,
	releaseOnQuit,
} from "../../extensions/lib/orchestrator.ts";
import { type SessionClaim, isProcessAlive, sessionsDir } from "../../extensions/lib/sessions.ts";

/** This suite's stand-in for a pi session. */
const SESSION = "test-session-main";
/** A second pi session, simulated by writing its claim file directly. */
const OTHER_SESSION = "test-session-other";

/** Write a claim as if another pi session had published it. */
function writeForeignClaim(sessionId: string, modelKey: string, pid: number): void {
	const claim: SessionClaim = { sessionId, pid, modelKey, updatedAt: Date.now() };
	fs.mkdirSync(sessionsDir(), { recursive: true });
	fs.writeFileSync(path.join(sessionsDir(), `${sessionId}.json`), JSON.stringify(claim), "utf-8");
}

function dropForeignClaim(sessionId: string): void {
	fs.rmSync(path.join(sessionsDir(), `${sessionId}.json`), { force: true });
}

/** A PID that is guaranteed dead: spawn a process, then wait for it to exit. */
function deadPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
		const pid = child.pid;
		if (pid === undefined) return reject(new Error("could not spawn a probe process"));
		child.once("exit", () => setTimeout(() => resolve(pid), 50));
		child.once("error", reject);
	});
}

/**
 * Stand in for pi's TUI, which is what normally keeps the process alive while
 * a load is awaited. `evictThenPreload` waits on an `lms load` child that is
 * unref'd on purpose, so without this the event loop empties mid-load and
 * `node --test` cancels the test ("Promise resolution is still pending but the
 * event loop has already resolved"), and every test after it with it.
 * Same reason as the interval in support/app-child.ts.
 */
const keepAlive = setInterval(() => {}, 1000);

after(() => {
	clearInterval(keepAlive);
	printTimingReport("LM Studio integration timings");
	cleanupAgentDir();
});

test("preflight: LM Studio is running and has enough models", { timeout: 120_000 }, async (t) => {
	const env = await timed(t, "preflight probe", preflight);

	t.diagnostic(`LM Studio server port: ${env.port ?? "unknown"}`);
	t.diagnostic(`catalogue: ${env.catalog.length} entries, ${env.chat.length} chat models`);
	for (const model of env.chat) {
		t.diagnostic(`  ${model.modelKey} — ${formatBytes(model.sizeBytes)}`);
	}
	t.diagnostic(
		`chosen (two smallest): ${env.small[0].modelKey} (${formatBytes(env.small[0].sizeBytes)}), ` +
			`${env.small[1].modelKey} (${formatBytes(env.small[1].sizeBytes)})`,
	);
	t.diagnostic(
		env.preexisting.length
			? `already resident before the suite: ${env.preexisting.join(", ")}`
			: "nothing was resident before the suite",
	);

	assert.notEqual(env.small[0].modelKey, env.small[1].modelKey, "the two test models must differ");
});

test("baseline: everything is evicted before the sequence starts", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const evicted = await timed(t, "reset to empty", resetLmStudio);
	t.diagnostic(evicted.length ? `evicted: ${evicted.join(", ")}` : "nothing to evict");
	assert.deepEqual(await residentIdentifiers(), [], "LM Studio should hold no models now");
});

test("memory estimate: lms reports a usable figure per model", { timeout: 120_000 }, async (t) => {
	const { small } = await preflight();

	for (const model of small) {
		const estimate = await timed(t, `estimate ${model.modelKey}`, () =>
			estimateMemory(model.modelKey),
		);
		assert.ok(estimate, `no estimate returned for ${model.modelKey}`);
		assert.equal(typeof estimate.totalBytes, "number", "totalBytes should be parsed");
		assert.ok((estimate.totalBytes ?? 0) > 0, "totalBytes should be positive");
		assert.equal(
			typeof estimate.passesGuardrails,
			"boolean",
			"the guardrail verdict should be parsed",
		);
		t.diagnostic(
			`${model.modelKey}: estimate ${formatBytes(estimate.totalBytes)} ` +
				`(vram ${formatBytes(estimate.vramBytes)}, confidence ${estimate.confidence ?? "?"}, ` +
				`passesGuardrails ${estimate.passesGuardrails}) vs file ${formatBytes(model.sizeBytes)}`,
		);
	}
});

test("evict + preload: loads the target into an empty LM Studio", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const { small } = await preflight();
	const target = small[0].modelKey;

	const outcome = await timed(t, `preload ${target} (cold)`, () =>
		evictThenPreload({ modelKey: target, sessionId: SESSION }),
	);

	assert.equal(outcome.locked, true, "the cross-process lock should have been taken");
	assert.equal(outcome.alreadyResident, false);
	assert.equal(outcome.loaded, true, `lms load failed for ${target}`);
	assert.deepEqual(await residentKeys(), [target], "only the target should be resident");
});

test("evict + preload: switching swaps one model for the other", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const { small } = await preflight();
	const [from, to] = [small[0].modelKey, small[1].modelKey];

	const outcome = await timed(t, `switch ${from} -> ${to}`, () =>
		evictThenPreload({ modelKey: to, sessionId: SESSION }),
	);

	t.diagnostic(`unloaded: ${outcome.unloaded.join(", ") || "(none)"}`);
	assert.equal(outcome.loaded, true, `lms load failed for ${to}`);
	assert.deepEqual(await residentKeys(), [to], `${from} should have been evicted`);
});

test(
	"evict + preload: re-selecting the resident model does not load a second copy",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		const { small } = await preflight();
		const target = small[1].modelKey;

		const outcome = await timed(t, `re-select ${target} (already resident)`, () =>
			evictThenPreload({ modelKey: target, sessionId: SESSION }),
		);

		assert.equal(outcome.alreadyResident, true, "the model was already in memory");
		assert.equal(outcome.loaded, false, "no load should have been issued");
		// LM Studio happily loads a second instance under `<key>:2`, which would
		// double the memory this extension exists to bound.
		const identifiers = await residentIdentifiers();
		assert.deepEqual(identifiers, [target], `expected exactly one instance, got ${identifiers.join(", ")}`);
	},
);

test("heal: reloads the active model after an external eviction", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const { small } = await preflight();
	const target = small[1].modelKey;

	// Simulate LM Studio's idle TTL firing, or a manual unload in the GUI.
	const identifier = ((await listLoaded()) ?? []).find(
		(model) => (model.modelKey ?? model.identifier) === target,
	)?.identifier;
	assert.ok(identifier, `${target} should be resident before this test evicts it`);
	await timed(t, `external unload of ${target}`, () => unload(identifier));
	assert.deepEqual(await residentKeys(), [], "the model should be gone before healing");

	const outcome = await timed(t, `heal ${target}`, () =>
		healIfEvicted({ modelKey: target, sessionId: SESSION }),
	);

	assert.equal(outcome.checked, true);
	assert.equal(outcome.wasEvicted, true, "heal should have noticed the eviction");
	assert.equal(outcome.reloaded, true, "heal should have issued the reload");
	assert.equal(outcome.ok, true, "the reload should have succeeded");
	assert.deepEqual(await residentKeys(), [target], "the model should be back");
});

test("heal: does nothing when the model is already resident", { timeout: 120_000 }, async (t) => {
	const { small } = await preflight();
	const target = small[1].modelKey;

	const outcome = await timed(t, `heal ${target} (no-op)`, () =>
		healIfEvicted({ modelKey: target, sessionId: SESSION }),
	);

	assert.equal(outcome.checked, true);
	assert.equal(outcome.wasEvicted, false, "nothing was evicted");
	assert.equal(outcome.reloaded, false, "no reload should have been issued");
	assert.deepEqual(await residentIdentifiers(), [target], "still exactly one instance");
});

test(
	"multi-session safety: a live claim from another session survives an eviction",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		const { small } = await preflight();
		const [target, claimed] = [small[0].modelKey, small[1].modelKey];

		// `claimed` is resident from the previous test; another live pi session
		// now says it is using it. This process is alive, so the claim is live.
		writeForeignClaim(OTHER_SESSION, claimed, process.pid);

		const outcome = await timed(t, `switch to ${target} while ${claimed} is claimed`, () =>
			evictThenPreload({ modelKey: target, sessionId: SESSION }),
		);

		t.diagnostic(`spared: ${outcome.spared.join(", ") || "(none)"}`);
		t.diagnostic(`unloaded: ${outcome.unloaded.join(", ") || "(none)"}`);
		assert.ok(outcome.spared.includes(claimed), `${claimed} should have been spared`);
		assert.deepEqual(
			await residentKeys(),
			[target, claimed].sort(),
			"both the claimed model and the new target should be resident",
		);
	},
);

test(
	"multi-session safety: dropping the claim lets the model be evicted again",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		const { small } = await preflight();
		const [target, released] = [small[0].modelKey, small[1].modelKey];

		dropForeignClaim(OTHER_SESSION);

		const outcome = await timed(t, `re-evict after releasing ${released}`, () =>
			evictThenPreload({ modelKey: target, sessionId: SESSION }),
		);

		assert.ok(outcome.unloaded.length > 0, `${released} should have been unloaded`);
		assert.equal(outcome.alreadyResident, true, `${target} was already resident`);
		assert.deepEqual(await residentKeys(), [target], "only the target should remain");
	},
);

test(
	"multi-session safety: a claim from a dead process protects nothing",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		const { small } = await preflight();
		const [resident, target] = [small[0].modelKey, small[1].modelKey];

		const pid = await deadPid();
		assert.equal(isProcessAlive(pid), false, "the probe process should be gone");
		writeForeignClaim(OTHER_SESSION, resident, pid);

		const outcome = await timed(t, `switch to ${target} past a stale claim`, () =>
			evictThenPreload({ modelKey: target, sessionId: SESSION }),
		);

		t.diagnostic(`unloaded: ${outcome.unloaded.join(", ") || "(none)"}`);
		assert.deepEqual(outcome.spared, [], "a dead session's claim must not spare anything");
		assert.deepEqual(await residentKeys(), [target], `${resident} should have been evicted`);
		dropForeignClaim(OTHER_SESSION);
	},
);

test(
	"multi-session safety: turning it off restores blanket eviction",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		const { small } = await preflight();
		const [target, claimed] = [small[0].modelKey, small[1].modelKey];

		// A genuinely live claim, which the previous tests proved is honoured.
		writeForeignClaim(OTHER_SESSION, claimed, process.pid);

		const outcome = await timed(t, `switch to ${target} with safety off`, () =>
			evictThenPreload({
				modelKey: target,
				sessionId: SESSION,
				config: { ...DEFAULTS, multiSessionSafety: false },
			}),
		);

		assert.deepEqual(outcome.spared, [], "with safety off nothing is spared");
		assert.deepEqual(await residentKeys(), [target], `${claimed} should have been evicted anyway`);
		dropForeignClaim(OTHER_SESSION);
	},
);

test(
	"a model still loading counts as resident, so no second copy is started",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		const { small } = await preflight();
		const target = small[0].modelKey;
		await resetLmStudio();

		// LM Studio publishes a model to `lms ps` several seconds before the
		// load finishes — with status "idle" and a placeholder contextLength,
		// so there is no "still loading" flag to key off. If residency were
		// judged any other way, this is where a duplicate `<key>:2` instance
		// would be born and double the memory.
		const loader = spawn(lmsBinary(), ["load", target, "--yes"], {
			stdio: "ignore",
			windowsHide: true,
		});
		const loaderExit = new Promise<void>((resolve) => loader.once("exit", () => resolve()));
		let loaderDone = false;
		void loaderExit.then(() => {
			loaderDone = true;
		});

		try {
			const appearedAt = await timed(t, `wait for ${target} to appear mid-load`, async () => {
				const deadline = Date.now() + 5 * 60_000;
				for (;;) {
					if (isResident((await listLoaded()) ?? [], target)) return Date.now();
					if (Date.now() > deadline) throw new Error(`${target} never appeared in lms ps`);
					await new Promise((resolve) => setTimeout(resolve, 120));
				}
			});
			t.diagnostic(`appeared before \`lms load\` exited: ${!loaderDone}`);
			if (loaderDone) {
				t.diagnostic("NOTE: the load finished before we observed it; the race was not exercised");
			}

			const outcome = await timed(t, "evictThenPreload against the in-flight load", () =>
				evictThenPreload({ modelKey: target, sessionId: SESSION }),
			);

			assert.equal(outcome.alreadyResident, true, "a loading model must count as resident");
			assert.equal(outcome.loaded, false, "no second load should have been issued");
			void appearedAt;
		} finally {
			// Let the original load finish before asserting, so the check is
			// against a settled state rather than a moving one.
			await loaderExit;
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}

		const identifiers = await residentIdentifiers();
		assert.deepEqual(
			identifiers,
			[target],
			`expected exactly one instance; a ":2" here means the duplicate guard failed (got ${identifiers.join(", ")})`,
		);
	},
);

/** The resident copies of `modelKey`, as `identifier@contextLength`. */
async function copiesOf(modelKey: string): Promise<string[]> {
	return ((await listLoaded()) ?? [])
		.filter((entry) => matchesModelKey(entry, modelKey))
		.map((entry) => `${entry.identifier}@${entry.contextLength}`);
}

test("context: a preload uses the configured context length", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const { small } = await preflight();
	const target = small[0].modelKey;
	await resetLmStudio();

	const outcome = await timed(t, "evictThenPreload at 16384", () =>
		evictThenPreload({ modelKey: target, sessionId: SESSION, contextLength: 16_384 }),
	);

	assert.equal(outcome.loaded, true);
	assert.deepEqual(await copiesOf(target), [`${target}@16384`]);
});

test("context: heal replaces a copy loaded at the wrong context", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const { small } = await preflight();
	const target = small[0].modelKey;
	await resetLmStudio();
	// What a just-in-time load at LM Studio's default looks like to us.
	assert.ok(await lmsRun(["load", target, "--yes", "--context-length", "4096"]), "setup load failed");

	const outcome = await timed(t, "heal from 4096 to 16384", () =>
		healIfEvicted({ modelKey: target, sessionId: SESSION, contextLength: 16_384 }),
	);

	assert.equal(outcome.wrongContext, true);
	assert.equal(outcome.reloaded, true);
	assert.equal(outcome.ok, true);
	assert.deepEqual(
		await copiesOf(target),
		[`${target}@16384`],
		"exactly one copy, at the new context — a ':2' means it reloaded before unloading",
	);
});

test(
	"context: heal leaves a wrong-context copy that another live session claims",
	{ timeout: LONG_TIMEOUT_MS },
	async () => {
		const { small } = await preflight();
		const target = small[0].modelKey;
		await resetLmStudio();
		assert.ok(await lmsRun(["load", target, "--yes", "--context-length", "16384"]), "setup load failed");
		writeForeignClaim(OTHER_SESSION, target, process.pid);
		try {
			const outcome = await healIfEvicted({ modelKey: target, sessionId: SESSION, contextLength: 4096 });
			assert.equal(outcome.wrongContext, true);
			assert.equal(outcome.reloaded, false, "the other session is using it as it is");
		} finally {
			dropForeignClaim(OTHER_SESSION);
		}
		assert.deepEqual(await copiesOf(target), [`${target}@16384`]);
	},
);

test(
	"context: a copy that is still loading is not unloaded for its context",
	{ timeout: LONG_TIMEOUT_MS },
	async (t) => {
		const { small } = await preflight();
		const target = small[0].modelKey;
		await resetLmStudio();

		// An external load at a different context, caught in flight.
		const loader = spawn(lmsBinary(), ["load", target, "--yes", "--context-length", "4096"], {
			stdio: "ignore",
			windowsHide: true,
		});
		let loaderDone = false;
		const loaderExit = new Promise<void>((resolve) => {
			loader.once("exit", () => {
				loaderDone = true;
				resolve();
			});
		});
		try {
			const deadline = Date.now() + 60_000;
			while (!isResident((await listLoaded()) ?? [], target)) {
				if (Date.now() > deadline) throw new Error(`${target} never appeared in lms ps`);
				await new Promise((resolve) => setTimeout(resolve, 120));
			}
			if (loaderDone) t.diagnostic("NOTE: the load finished before we observed it; the race was not exercised");

			const outcome = await healIfEvicted({ modelKey: target, sessionId: SESSION, contextLength: 16_384 });
			if (!loaderDone) {
				assert.equal(outcome.reloaded, false, "a loading copy must be left to finish");
			}
		} finally {
			await loaderExit;
		}
		assert.equal((await copiesOf(target)).length, 1, "no duplicate either way");
	},
);

test("extra load args: reach lms, and a bad one fails the load", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const { small } = await preflight();
	const target = small[0].modelKey;
	await resetLmStudio();

	const good = await timed(t, "preload with --parallel 2", () =>
		evictThenPreload({
			modelKey: target,
			sessionId: SESSION,
			config: { ...DEFAULTS, extraLoadArgs: ["--parallel", "2", "--context-length", "999"] },
			contextLength: 16_384,
		}),
	);
	assert.equal(good.loaded, true);
	const entry = ((await listLoaded()) ?? []).find((e) => matchesModelKey(e, target)) as
		| { parallel?: number; contextLength?: number }
		| undefined;
	assert.equal(entry?.parallel, 2, "--parallel reached lms");
	assert.equal(entry?.contextLength, 16_384, "a user --context-length is dropped, ours wins");

	await resetLmStudio();
	const bad = await evictThenPreload({
		modelKey: target,
		sessionId: SESSION,
		config: { ...DEFAULTS, extraLoadArgs: ["--definitely-not-a-flag"] },
	});
	assert.equal(bad.loaded, false, "lms rejects unknown flags, and the outcome says so");
});

test("quit: spares a claimed model, unloads an unclaimed one", { timeout: LONG_TIMEOUT_MS }, async () => {
	const { small } = await preflight();
	const target = small[0].modelKey;
	await resetLmStudio();
	assert.ok(await lmsRun(["load", target, "--yes"]), "setup load failed");
	const config = { ...DEFAULTS, unloadOnQuit: true };

	writeForeignClaim(OTHER_SESSION, target, process.pid);
	try {
		const spared = await releaseOnQuit({ modelKey: target, sessionId: SESSION, config });
		assert.equal(spared.spared, true);
		assert.equal((await copiesOf(target)).length, 1);
	} finally {
		dropForeignClaim(OTHER_SESSION);
	}

	const released = await releaseOnQuit({ modelKey: target, sessionId: SESSION, config });
	assert.equal(released.spared, false);
	assert.deepEqual(await copiesOf(target), [], "unloaded once no one else claims it");

	const off = await releaseOnQuit({ modelKey: target, sessionId: SESSION, config: DEFAULTS });
	assert.deepEqual(off.unloaded, [], "nothing happens with the settings off");
});

test("server: ensureServer starts a stopped server, and only when asked", { timeout: 180_000 }, async (t) => {
	const before = await serverStatus();
	assert.ok(before, "lms server status must answer");
	try {
		assert.ok(await stopServer(), "stop failed");
		assert.equal((await serverStatus())?.running, false);

		assert.equal(await ensureServer({ config: DEFAULTS }), undefined, "off by default");
		assert.equal((await serverStatus())?.running, false);

		const started = await timed(t, "ensureServer from stopped", () =>
			ensureServer({ config: { ...DEFAULTS, startServer: true } }),
		);
		assert.equal(started, true);
		assert.equal((await serverStatus())?.running, true);
		assert.equal(await ensureServer({ config: { ...DEFAULTS, startServer: true } }), false, "already up");
	} finally {
		// Leave the server as the suite found it.
		if (before.running && !(await serverStatus())?.running) await lmsRun(["server", "start"]);
	}
});

test("teardown: LM Studio is left empty", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const started = Date.now();
	await resetLmStudio();
	recordTiming(t, "final reset", Date.now() - started);
	assert.deepEqual(await residentIdentifiers(), [], "the suite should not leave models resident");
});
