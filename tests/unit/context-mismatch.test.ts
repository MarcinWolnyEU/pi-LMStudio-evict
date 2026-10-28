/**
 * A load that exits 0 but leaves the model at another context than requested
 * must not make the heal unload and reload it on every turn.
 *
 * Confirmed triggers: combined short flags such as `-yc2048`, a fractional
 * context length, any LM Studio build that adjusts the context. The fake
 * reports whatever context the test wants after a successful load.
 * Needs `--experimental-test-module-mocks` (set in the npm scripts).
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { type Installed, copy, installFakeLms } from "../support/fake-lms.ts";

const env: Installed = await installFakeLms();
const { fake } = env;

const REQUESTED = 32_768;
const ACTUAL = 2_048;
const SESSION = "context-mismatch-session";
// The failure memory is per process; a key per test keeps the tests apart.
let n = 0;
let target = "";
beforeEach(() => {
	target = `vendor/mismatch-${++n}`;
});
const config = (contextLength = REQUESTED) => env.config.withDefaults({ contextLength, multiSessionSafety: true });
const noContext = () => env.config.withDefaults({ multiSessionSafety: true });
const heal = (cfg = config()) => env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: cfg });

after(() => fake.cleanup());

describe("healIfEvicted, context check after the reload", () => {
	test("the reload comes up at another context: reported, ok, and not repeated next turn", async () => {
		fake.reset([copy(target, 4_096)]);
		fake.contextAfterLoad = () => ACTUAL;

		const first = await heal();
		assert.equal(first.reloaded, true);
		assert.equal(first.ok, true, "the model is loaded");
		assert.deepEqual(first.contextMismatch, { requested: REQUESTED, actual: ACTUAL });
		assert.deepEqual(fake.copiesOf(target), [`${target}@${ACTUAL}`]);

		fake.calls = [];
		const second = await heal();
		assert.deepEqual(fake.calls, [], "no unload and no load on the next turn");
		assert.equal(second.reloaded, false);
		assert.equal(second.contextMismatch, undefined, "reported once");
	});

	test("the loop without the check: the copy looks wrong again and would be reloaded", async () => {
		// What the heal sees on the next turn, to show the check is what stops it.
		fake.reset([copy(target, ACTUAL)]);
		assert.equal(env.orchestrator.hasWrongContext(fake.loaded[0], REQUESTED), true);
	});

	test("the context is as requested: no mismatch", async () => {
		fake.reset([copy(target, 4_096)]);
		const outcome = await heal();
		assert.equal(outcome.ok, true);
		assert.equal(outcome.contextMismatch, undefined);
	});

	test("judged although lastUsedTime is still null: our own load has returned", async () => {
		fake.reset([copy(target, 4_096)]);
		fake.contextAfterLoad = () => ACTUAL;
		fake.lastUsedAfterLoad = null;
		const outcome = await heal();
		assert.deepEqual(outcome.contextMismatch, { requested: REQUESTED, actual: ACTUAL });
	});

	test("a request above the model's maximum is met at the maximum", async () => {
		fake.reset([copy(target, 4_096)]);
		fake.contextAfterLoad = () => 262_144; // the copy's maxContextLength
		const outcome = await heal(config(500_000));
		assert.equal(outcome.contextMismatch, undefined);
	});

	test("a model evicted outright is checked too", async () => {
		fake.reset([]);
		fake.contextAfterLoad = () => ACTUAL;
		const outcome = await heal();
		assert.equal(outcome.wasEvicted, true);
		assert.deepEqual(outcome.contextMismatch, { requested: REQUESTED, actual: ACTUAL });
	});

	test("no context in force: nothing to compare", async () => {
		fake.reset([]);
		fake.contextAfterLoad = () => ACTUAL;
		const outcome = await heal(noContext());
		assert.equal(outcome.ok, true);
		assert.equal(outcome.contextMismatch, undefined);
	});
});

describe("evictThenPreload, context check after the load", () => {
	test("the load comes up at another context: reported, and the heal leaves it alone", async () => {
		fake.reset([]);
		fake.contextAfterLoad = () => ACTUAL;
		const outcome = await env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: config() });
		assert.equal(outcome.loaded, true);
		assert.deepEqual(outcome.contextMismatch, { requested: REQUESTED, actual: ACTUAL });

		fake.calls = [];
		await heal();
		assert.deepEqual(fake.calls, []);
	});

	test("the context is as requested: no mismatch", async () => {
		fake.reset([]);
		const outcome = await env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: config() });
		assert.equal(outcome.loaded, true);
		assert.equal(outcome.contextMismatch, undefined);
	});

	test("no context in force: nothing to compare", async () => {
		fake.reset([]);
		fake.contextAfterLoad = () => ACTUAL;
		const outcome = await env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: noContext() });
		assert.equal(outcome.contextMismatch, undefined);
	});
});
