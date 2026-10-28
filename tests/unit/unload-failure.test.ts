/**
 * A failed unload of a wrong-context copy must not be followed by a load.
 * `lms load` on a resident key adds a second copy, `<key>:2` (measured), so
 * loading anyway would double the memory the extension exists to save.
 *
 * Runs against a fake LM Studio (tests/support/fake-lms.ts) in which unloads
 * can fail. Needs `--experimental-test-module-mocks` (set in the npm scripts).
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { type Installed, copy, installFakeLms } from "../support/fake-lms.ts";

const env: Installed = await installFakeLms();
const { fake } = env;

const CONFIGURED = 32_768;
const WRONG = 4_096;
const SESSION = "unload-failure-session";
// The failure memory is per process and keyed by the load arguments, so each
// test uses its own model key.
let n = 0;
let target = "";
beforeEach(() => {
	target = `vendor/model-${++n}`;
});
const config = () => env.config.withDefaults({ contextLength: CONFIGURED, multiSessionSafety: true });

after(() => fake.cleanup());

describe("healIfEvicted, wrong-context copy", () => {
	test("control: the unload works, so one load and no duplicate", async () => {
		fake.reset([copy(target, WRONG)]);
		const outcome = await env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: config() });
		assert.deepEqual(fake.calls.map((call) => call[0]), ["unload", "load"]);
		assert.deepEqual(fake.copiesOf(target), [`${target}@${CONFIGURED}`]);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.unloadFailed, undefined);
	});

	test("the unload fails: no load, the old copy stays, ok is false", async () => {
		fake.reset([copy(target, WRONG)]);
		fake.failUnload = true;
		const outcome = await env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: config() });
		assert.deepEqual(fake.calls[0], ["unload", target], "the unload was attempted");
		assert.deepEqual(fake.loadCalls(), [], "no load after a failed unload");
		assert.deepEqual(fake.copiesOf(target), [`${target}@${WRONG}`]);
		assert.equal(outcome.ok, false);
		assert.equal(outcome.reloaded, false);
		assert.equal(outcome.unloadFailed, true);
	});

	test("the failure is remembered: the next turn does not unload again", async () => {
		fake.reset([copy(target, WRONG)]);
		fake.failUnload = true;
		await env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: config() });
		fake.calls = [];
		const again = await env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: config() });
		assert.deepEqual(fake.calls, [], "nothing attempted while the failure is remembered");
		assert.equal(again.reloaded, false);
		assert.equal(again.ok, true, "the working copy keeps serving; no repeated warning");
	});

	test("the unload reports failure but the copy is gone: the load goes ahead", async () => {
		fake.reset([copy(target, WRONG)]);
		fake.failUnload = true;
		// The copy goes away on its own (TTL, the GUI) just as the unload errors.
		fake.afterFailedUnload = () => {
			fake.loaded = [];
		};
		const outcome = await env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: config() });
		assert.equal(fake.loadCalls().length, 1);
		assert.equal(outcome.unloadFailed, undefined);
	});
});

describe("evictThenPreload, wrong-context copy", () => {
	test("control: the unload works, so one load and no duplicate", async () => {
		fake.reset([copy(target, WRONG)]);
		const outcome = await env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: config() });
		assert.deepEqual(fake.calls.map((call) => call[0]), ["unload", "load"]);
		assert.deepEqual(fake.copiesOf(target), [`${target}@${CONFIGURED}`]);
		assert.equal(outcome.loaded, true);
	});

	test("unloadAll branch (nothing else to keep) fails: no load", async () => {
		fake.reset([copy(target, WRONG)]);
		fake.failUnload = true;
		const outcome = await env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: config() });
		assert.deepEqual(fake.calls[0], ["unload", "--all"]);
		assert.deepEqual(fake.loadCalls(), []);
		assert.deepEqual(fake.copiesOf(target), [`${target}@${WRONG}`]);
		assert.equal(outcome.loaded, false);
		assert.equal(outcome.unloadFailed, true);
	});

	test("per-identifier branch (another session's model is kept) fails: no load", async () => {
		// Another live session holds a different model, so `keep` is not empty
		// and the victims are unloaded one by one.
		fake.reset([copy(target, WRONG), copy("vendor/other", 8_192)]);
		env.sessions.writeClaim("other-session", "vendor/other");
		fake.failUnload = true;
		const outcome = await env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: config() });
		assert.deepEqual(fake.calls[0], ["unload", target]);
		assert.deepEqual(fake.loadCalls(), []);
		assert.deepEqual(fake.copiesOf(target), [`${target}@${WRONG}`]);
		assert.equal(outcome.loaded, false);
		assert.equal(outcome.unloadFailed, true);
	});

	test("the failure is remembered, so the heal that follows leaves the copy alone", async () => {
		fake.reset([copy(target, WRONG)]);
		fake.failUnload = true;
		await env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: config() });
		fake.calls = [];
		const heal = await env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: config() });
		assert.deepEqual(fake.calls, []);
		assert.equal(heal.reloaded, false);
	});

	test("a model that will not unload does not stop the target loading when it is absent", async () => {
		fake.reset([copy("vendor/stranger", 8_192)]);
		fake.failUnload = true;
		const outcome = await env.orchestrator.evictThenPreload({ modelKey: target, sessionId: SESSION, config: config() });
		assert.equal(fake.loadCalls().length, 1);
		assert.equal(outcome.loaded, true);
		assert.equal(outcome.unloadFailed, undefined);
	});
});
