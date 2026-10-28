/**
 * `ensureServer` against a fake LM Studio: up to three `lms server start`
 * attempts, a status re-check after each failure, progress reporting.
 *
 * Needs `--experimental-test-module-mocks` (set in the npm scripts).
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { type Installed, installFakeLms } from "../support/fake-lms.ts";

const env: Installed = await installFakeLms();
const on = () => env.config.withDefaults({ startServer: true });

after(() => env.fake.cleanup());
beforeEach(() => env.fake.reset());

const starts = () => env.fake.calls.filter((call) => call[0] === "server");

describe("ensureServer", () => {
	test("up on the first attempt: one start, reported as started", async () => {
		env.fake.startResults = [true];
		const seen: string[] = [];
		const outcome = await env.orchestrator.ensureServer({
			config: on(),
			pauseMs: 0,
			onAttempt: (attempt, of) => seen.push(`${attempt}/${of}`),
		});
		assert.equal(outcome, "started");
		assert.equal(starts().length, 1);
		assert.deepEqual(seen, ["1/3"]);
	});

	test("fails once, succeeds on attempt 2: two starts, progress for both", async () => {
		env.fake.startResults = [false, true];
		const seen: string[] = [];
		const outcome = await env.orchestrator.ensureServer({
			config: on(),
			pauseMs: 0,
			onAttempt: (attempt, of) => seen.push(`${attempt}/${of}`),
		});
		assert.equal(outcome, "started");
		assert.equal(starts().length, 2);
		assert.deepEqual(seen, ["1/3", "2/3"]);
	});

	test("never comes up: exactly three attempts, then failed", async () => {
		env.fake.startResults = [false, false, false, true]; // a 4th would succeed, and must not run
		const seen: string[] = [];
		const outcome = await env.orchestrator.ensureServer({
			config: on(),
			pauseMs: 0,
			onAttempt: (attempt, of) => seen.push(`${attempt}/${of}`),
		});
		assert.equal(outcome, "failed");
		assert.equal(starts().length, 3);
		assert.deepEqual(seen, ["1/3", "2/3", "3/3"]);
		assert.equal(env.fake.serverRunning, false);
	});

	test("a failed attempt that left the server up ends the loop", async () => {
		env.fake.startResults = [false, true];
		env.fake.comesUpOnFailure = true; // e.g. the 60 s timeout hit while it was still booting
		const outcome = await env.orchestrator.ensureServer({ config: on(), pauseMs: 0 });
		assert.equal(outcome, "started");
		assert.equal(starts().length, 1, "status was re-checked and no second start issued");
	});

	test("pauses between attempts, not after the last one", async () => {
		env.fake.startResults = [false, false, false];
		const started = Date.now();
		await env.orchestrator.ensureServer({ config: on(), pauseMs: 60 });
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 100, `two pauses of 60 ms expected, took ${elapsed} ms`);
		assert.ok(elapsed < 1500, `no pause after the final attempt, took ${elapsed} ms`);
	});

	test("setting off: no status check, no attempt", async () => {
		env.fake.startResults = [true];
		const outcome = await env.orchestrator.ensureServer({ config: env.config.withDefaults({}), pauseMs: 0 });
		assert.equal(outcome, "off");
		assert.deepEqual(env.fake.calls, []);
	});

	test("server already up: no attempt", async () => {
		env.fake.serverRunning = true;
		env.fake.startResults = [true];
		const seen: string[] = [];
		const outcome = await env.orchestrator.ensureServer({
			config: on(),
			pauseMs: 0,
			onAttempt: (attempt) => seen.push(String(attempt)),
		});
		assert.equal(outcome, "up");
		assert.equal(starts().length, 0);
		assert.deepEqual(seen, []);
	});
});
