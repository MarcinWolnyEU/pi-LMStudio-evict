/**
 * The picker's loading indicator, driven with a fake pi context.
 *
 * The TUI is the only place the real loader exists, so these stand in for it:
 * `custom()` runs the component factory and resolves with whatever it passes
 * to `done`, the way pi's `showExtensionCustom` does (first call wins).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CANCELLED, COMMAND_STATUS_KEY, type LoaderClass, withLoader, withStatus } from "../../extensions/lib/loading.ts";

class FakeLoader {
	static last: FakeLoader | undefined;
	readonly controller = new AbortController();
	onAbort: (() => void) | undefined;
	readonly message: string;
	constructor(_tui: unknown, _theme: unknown, message: string) {
		this.message = message;
		FakeLoader.last = this;
	}
	get signal(): AbortSignal {
		return this.controller.signal;
	}
	/** What Escape does in pi's CancellableLoader: abort, then notify. */
	escape(): void {
		this.controller.abort();
		this.onAbort?.();
	}
}

const fakeLoaderClass = FakeLoader as unknown as LoaderClass;
const loaderLoads = async () => fakeLoaderClass;

interface Harness {
	ctx: ExtensionCommandContext;
	statuses: Array<[string, string | undefined]>;
	notices: Array<[string, string | undefined]>;
}

function harness(mode: string): Harness {
	const statuses: Harness["statuses"] = [];
	const notices: Harness["notices"] = [];
	const ctx = {
		mode,
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
			notify: (message: string, type?: string) => notices.push([message, type]),
			custom: (factory: (...args: unknown[]) => unknown) =>
				new Promise((resolve) => {
					let done = false;
					factory({}, {}, {}, (result: unknown) => {
						if (done) return;
						done = true;
						// pi's wrappers add promise hops between `done` and the awaiting
						// command; a failure can slip in during them.
						void Promise.resolve()
							.then(() => {})
							.then(() => {})
							.then(() => resolve(result));
					});
				}),
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, statuses, notices };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("withLoader: in the TUI, returns what the work resolves to", async () => {
	const { ctx, statuses } = harness("tui");
	const result = await withLoader(ctx, "Reading…", async () => 42, loaderLoads);
	assert.equal(result, 42);
	assert.equal(FakeLoader.last?.message, "Reading…");
	assert.deepEqual(statuses, [], "the loader replaces the footer line");
});

test("withLoader: Escape resolves CANCELLED, aborts the signal, and ignores late results", async () => {
	const { ctx } = harness("tui");
	let release!: (value: string) => void;
	let seen: AbortSignal | undefined;
	const pending = withLoader(
		ctx,
		"Reading…",
		(signal) => {
			seen = signal;
			return new Promise<string>((resolve) => {
				release = resolve;
			});
		},
		loaderLoads,
	);
	await tick();
	FakeLoader.last?.escape();
	assert.equal(await pending, CANCELLED);
	assert.equal(seen?.aborted, true);
	release("late"); // must not throw or resolve anything twice
	await tick();
});

test("withLoader: a failure reaches the caller instead of looking like Escape", async () => {
	const { ctx } = harness("tui");
	await assert.rejects(
		withLoader(ctx, "Reading…", async () => Promise.reject(new Error("lms exploded")), loaderLoads),
		/lms exploded/,
	);
});

test("withLoader: a failure after Escape is dropped", async () => {
	const { ctx } = harness("tui");
	let fail!: (error: Error) => void;
	const pending = withLoader(
		ctx,
		"Reading…",
		() =>
			new Promise<string>((_resolve, reject) => {
				fail = reject;
			}),
		loaderLoads,
	);
	await tick();
	// Same tick, so the failure lands before `withLoader` resumes after Escape.
	FakeLoader.last?.escape();
	fail(new Error("too late"));
	assert.equal(await pending, CANCELLED);
});

test("withLoader: outside the TUI it uses the footer status and never builds a loader", async () => {
	FakeLoader.last = undefined;
	const { ctx, statuses } = harness("rpc");
	const result = await withLoader(ctx, "Reading…", async (signal) => (signal.aborted ? "aborted" : "ok"), loaderLoads);
	assert.equal(result, "ok");
	assert.equal(FakeLoader.last, undefined);
	assert.deepEqual(statuses, [
		[COMMAND_STATUS_KEY, "lmstudio: Reading…"],
		[COMMAND_STATUS_KEY, undefined],
	]);
});

test("withLoader: if the loader can't be loaded in the TUI, it warns and still does the work", async () => {
	const { ctx, statuses, notices } = harness("tui");
	const result = await withLoader(
		ctx,
		"Reading…",
		async () => "ok",
		async () => {
			throw new Error("Cannot find package");
		},
	);
	assert.equal(result, "ok");
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.[1], "warning");
	assert.match(notices[0]?.[0] ?? "", /Cannot find package/);
	assert.equal(statuses.at(-1)?.[1], undefined, "the footer line is cleared afterwards");
});

test("withStatus: clears the footer line when the action throws", async () => {
	const { ctx, statuses } = harness("tui");
	await assert.rejects(
		withStatus(ctx, "working", async () => Promise.reject(new Error("boom"))),
		/boom/,
	);
	assert.deepEqual(statuses, [
		[COMMAND_STATUS_KEY, "working"],
		[COMMAND_STATUS_KEY, undefined],
	]);
});
