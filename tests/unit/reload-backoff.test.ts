/**
 * A failed wrong-context fix is remembered for `RELOAD_RETRY_MS`, not for the
 * life of the process, and only for the exact `lms load` arguments that failed.
 *
 * The clock is `mock.timers` (Date only), so the ten minutes pass instantly.
 * Needs `--experimental-test-module-mocks` (set in the npm scripts).
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";
import { type Installed, copy, installFakeLms } from "../support/fake-lms.ts";

const env: Installed = await installFakeLms();
const { fake } = env;
const { RELOAD_RETRY_MS } = env.orchestrator;

const SESSION = "backoff-session";
// The failure memory is per process; a key per test keeps the tests apart.
let n = 0;
let target = "";
const config = (contextLength = 32_768, extra: string[] = []) =>
	env.config.withDefaults({ contextLength, extraLoadArgs: extra, multiSessionSafety: true });
const heal = (cfg = config()) => env.orchestrator.healIfEvicted({ modelKey: target, sessionId: SESSION, config: cfg });
const unloads = () => fake.calls.filter((call) => call[0] === "unload").length;

/** What pi's next request leaves behind after a failed fix: a just-in-time copy at the default. */
function jitCopy(): void {
	fake.reset([copy(target, 4_096)]);
	fake.loadOk = false;
}

beforeEach(() => {
	target = `vendor/backoff-${++n}`;
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
});
afterEach(() => mock.timers.reset());
after(() => fake.cleanup());

describe("failed reload backoff", () => {
	test("a failed reload is not retried inside the window, and is after it", async () => {
		jitCopy();
		const first = await heal();
		assert.equal(first.wrongContext, true);
		assert.equal(first.ok, false, "the load failed");

		jitCopy();
		mock.timers.tick(RELOAD_RETRY_MS - 1);
		const inside = await heal();
		assert.equal(inside.reloaded, false);
		assert.equal(unloads(), 0, "the working copy is left alone");
		assert.deepEqual(fake.copiesOf(target), [`${target}@4096`]);

		mock.timers.tick(1);
		const after = await heal();
		assert.equal(after.reloaded, true, "the window is over, so it tries again");
		assert.equal(unloads(), 1);
		assert.equal(fake.loadCalls().length, 1);
	});

	test("a retry that works clears the memory", async () => {
		jitCopy();
		await heal();
		mock.timers.tick(RELOAD_RETRY_MS);

		jitCopy();
		fake.loadOk = true;
		const retry = await heal();
		assert.equal(retry.ok, true);
		assert.deepEqual(fake.copiesOf(target), [`${target}@32768`]);

		// A later wrong-context copy is fixed at once; nothing is held against it.
		fake.reset([copy(target, 4_096)]);
		const next = await heal();
		assert.equal(next.reloaded, true);
		assert.equal(next.ok, true);
	});

	test("a failed retry starts a new window", async () => {
		jitCopy();
		await heal();
		mock.timers.tick(RELOAD_RETRY_MS);
		jitCopy();
		const retry = await heal();
		assert.equal(retry.reloaded, true);
		assert.equal(retry.ok, false);

		jitCopy();
		mock.timers.tick(RELOAD_RETRY_MS - 1);
		assert.equal((await heal()).reloaded, false, "remembered again from the retry");
	});

	test("a changed config is a different attempt and runs at once", async () => {
		jitCopy();
		await heal(config(32_768));

		jitCopy();
		assert.equal((await heal(config(32_768))).reloaded, false);

		jitCopy();
		const changed = await heal(config(16_384));
		assert.equal(changed.reloaded, true, "another context length is not held back");

		jitCopy();
		const flags = await heal(config(32_768, ["--gpu", "max"]));
		assert.equal(flags.reloaded, true, "other load flags are not held back");
	});

	test("a failed unload is held back the same way", async () => {
		fake.reset([copy(target, 4_096)]);
		fake.failUnload = true;
		await heal();

		fake.calls = [];
		mock.timers.tick(RELOAD_RETRY_MS - 1);
		await heal();
		assert.deepEqual(fake.calls, []);

		mock.timers.tick(1);
		await heal();
		assert.equal(unloads(), 1, "the unload is tried again after the window");
	});
});
