/**
 * Never unload a copy another client is using.
 *
 * LM Studio's chat or another app can be mid-request on the model pi wants at
 * a different context. `lms unload` cuts that stream off within about a second
 * (measured, see AGENTS.md), so the heal and the switch leave a busy copy
 * alone and the next turn tries again. A copy is busy when `lms ps` reports a
 * `status` other than "idle", or requests `queued` behind its `parallel` limit.
 *
 * Needs `--experimental-test-module-mocks` (set in the npm scripts).
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { type Installed, copy, installFakeLms } from "../support/fake-lms.ts";

const env: Installed = await installFakeLms();
const { fake } = env;

const CONFIGURED = 32_768;
const WRONG = 4_096;
const SESSION = "busy-copy-session";
// The failure memory is per process; a key per test keeps the tests apart.
let n = 0;
let target = "";
beforeEach(() => {
	target = `vendor/busy-${++n}`;
});
const config = () => env.config.withDefaults({ contextLength: CONFIGURED, multiSessionSafety: true });
const heal = () => env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: config() });
const evict = () => env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: config() });

/** A wrong-context copy with a finished load (lastUsedTime set), so it is judged, plus its busy state. */
function busyCopy(state: { status?: string; queued?: number }) {
	return { ...copy(target, WRONG), ...state };
}

after(() => fake.cleanup());

describe("healIfEvicted, wrong-context copy in use", () => {
	for (const [name, state] of [
		["generating", { status: "generating" }],
		["processingPrompt", { status: "processingPrompt" }],
		["idle with requests queued", { status: "idle", queued: 2 }],
	] as const) {
		test(`${name}: not unloaded, not reloaded`, async () => {
			fake.reset([busyCopy(state)]);
			const outcome = await heal();
			assert.deepEqual(fake.calls, [], "no unload and no load");
			assert.deepEqual(fake.copiesOf(target), [`${target}@${WRONG}`]);
			assert.equal(outcome.reloaded, false);
			assert.equal(outcome.wrongContext, true);
			assert.equal(outcome.busy, true);
		});
	}

	test("the next turn, once it is idle, fixes the context", async () => {
		fake.reset([busyCopy({ status: "generating" })]);
		await heal();
		fake.loaded[0].status = "idle";
		const outcome = await heal();
		assert.deepEqual(fake.calls.map((call) => call[0]), ["unload", "load"]);
		assert.deepEqual(fake.copiesOf(target), [`${target}@${CONFIGURED}`]);
		assert.equal(outcome.reloaded, true);
		assert.equal(outcome.busy, undefined);
	});

	test("control: idle, nothing queued, is fixed at once", async () => {
		fake.reset([busyCopy({ status: "idle", queued: 0 })]);
		const outcome = await heal();
		assert.deepEqual(fake.calls.map((call) => call[0]), ["unload", "load"]);
		assert.equal(outcome.ok, true);
	});
});

describe("planEviction, wrong-context copy in use", () => {
	test("a busy copy is kept as usable, like a claimed one", () => {
		const loaded = [busyCopy({ status: "generating" })];
		const plan = env.orchestrator.planEviction(loaded, target, new Set(), CONFIGURED);
		assert.deepEqual(plan.victims, []);
		assert.equal(plan.targetResident, true);
	});

	test("an idle copy at the wrong context is a victim", () => {
		const plan = env.orchestrator.planEviction([busyCopy({ status: "idle" })], target, new Set(), CONFIGURED);
		assert.equal(plan.victims.length, 1);
		assert.equal(plan.targetResident, false);
	});
});

describe("evictThenPreload, wrong-context copy in use", () => {
	test("the busy copy stays, nothing is loaded beside it", async () => {
		fake.reset([busyCopy({ status: "generating" })]);
		const outcome = await evict();
		assert.deepEqual(fake.calls, []);
		assert.equal(outcome.alreadyResident, true);
		assert.equal(outcome.loaded, false);
		assert.deepEqual(fake.copiesOf(target), [`${target}@${WRONG}`]);
	});

	test("other models still go", async () => {
		fake.reset([busyCopy({ queued: 1 }), copy("vendor/stranger", 8_192)]);
		await evict();
		assert.deepEqual(fake.calls, [["unload", "vendor/stranger"]]);
		assert.deepEqual(fake.copiesOf(target), [`${target}@${WRONG}`]);
	});
});
