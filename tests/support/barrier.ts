/**
 * Cross-process rendezvous, for tests that need a specific *ordering*
 * between processes rather than a specific timing.
 *
 * Timing-based interleaving ("sleep 5ms and hope") is the flakiness these
 * tests exist to avoid. A barrier expresses the real requirement — "wait
 * until the other process has actually created its lock" — so the test
 * either reproduces the interleaving deterministically or fails loudly.
 *
 * `SIGSTOP`/`SIGCONT` would be the obvious tool and is not available:
 * Node's `process.kill` rejects both with `ERR_UNKNOWN_SIGNAL` on Windows.
 * Files plus a synchronous sleep work everywhere.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Backing store for the synchronous sleep. `Atomics.wait` blocks the calling
 * thread outright, which is what we want: a barrier must not let the event
 * loop run and perturb the interleaving under test.
 */
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));

/** Block this thread for `ms`, without yielding to the event loop. */
export function sleepSync(ms: number): void {
	Atomics.wait(SLEEP_SLOT, 0, 0, ms);
}

/** Raise `name`, releasing anyone blocked in `waitFor`. */
export function signal(dir: string, name: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), String(Date.now()), "utf-8");
}

/** True when `name` has been raised. */
export function isSignalled(dir: string, name: string): boolean {
	return fs.existsSync(path.join(dir, name));
}

/**
 * Block until `name` is raised. Throws on timeout rather than hanging, so a
 * barrier that is never reached fails the test with a useful message instead
 * of stalling the runner.
 */
export function waitFor(dir: string, name: string, timeoutMs = 10_000): void {
	const target = path.join(dir, name);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(target)) {
		if (Date.now() > deadline) {
			throw new Error(`barrier "${name}" timed out after ${timeoutMs}ms (dir: ${dir})`);
		}
		sleepSync(1);
	}
}

/** Remove every raised signal, so a directory can be reused between cases. */
export function resetBarriers(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
}
