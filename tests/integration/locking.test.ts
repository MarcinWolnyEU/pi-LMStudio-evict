/**
 * Cross-process locking and session claims.
 *
 * Two kinds of test live here.
 *
 * **Mutual exclusion under contention** spawns real child processes. An
 * in-process test would pass even if the lock were a module-level boolean,
 * which is exactly the bug that matters when a second pi window is open.
 *
 * **The race tests** steer two children through one exact interleaving using
 * barrier files and the `hooks` seam, rather than sleeping and hoping. That
 * makes them deterministic in both directions: they fail reliably against a
 * broken implementation and pass reliably against a correct one, with no
 * flake in between. `proper-lockfile` tests its races the same way (via its
 * `options.fs` seam) and ships no multi-process stress test at all.
 *
 * A note on what is being asserted. The stale-break race *cannot* be closed
 * by a filesystem lock in pure Node — deciding a lock is stale and unlinking
 * it are two syscalls, and nothing makes the pair atomic. So the invariant
 * is not "mutual exclusion always holds"; it is "either it holds, or the
 * victim detects that its lock was stolen". Detection is what lets
 * `evictThenPreload` decline to unload anything on a stolen lock.
 */

import { LONG_TIMEOUT_MS, cleanupAgentDir, formatMs, printTimingReport, timed } from "./harness.ts";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CLAIM_STALE_MS,
	UNREADABLE_GRACE_MS,
	acquireLock,
	bootTime,
	claimedByOthers,
	dropClaim,
	isProcessAlive,
	lockPath,
	pruneDeadClaims,
	readClaims,
	sessionsDir,
	withLock,
	writeClaim,
} from "../../extensions/lib/sessions.ts";
import { resetBarriers, signal } from "../support/barrier.ts";
import { analyse } from "../support/event-log.ts";

const CHILD = fileURLToPath(new URL("./lock-child.ts", import.meta.url));

let scratchCounter = 0;
function scratch(name: string): string {
	const dir = path.join(os.tmpdir(), `pi-lmstudio-evict-lock-${process.pid}-${scratchCounter++}`);
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, name);
}

interface ChildReport {
	scenario: string;
	pid: number;
	acquired?: boolean;
	token?: string;
	start?: number;
	end?: number;
	stillValid?: boolean;
	compromised?: boolean;
	error?: string;
}

function runChild(scenario: string, barrierDir: string, logPath: string, ...rest: string[]) {
	return new Promise<ChildReport>((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD, scenario, barrierDir, logPath, ...rest], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			// Children must agree with the parent on where the lock lives.
			env: { ...process.env, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR },
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			const line = out.trim().split(/\r?\n/).pop() ?? "";
			try {
				resolve(JSON.parse(line) as ChildReport);
			} catch {
				// `crash-after-create` exits without a report by design.
				resolve({ scenario, pid: child.pid ?? -1, error: `exit ${code}; stdout=${out}; stderr=${err}` });
			}
		});
	});
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

/** Plant a well-formed lock record belonging to someone else. */
function plantLock(pid: number, token = "planted", ageMs = 0): void {
	fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
	fs.writeFileSync(
		lockPath(),
		JSON.stringify({ v: 2, pid, token, at: Date.now() - ageMs, host: os.hostname(), bootTime: bootTime() }),
	);
	if (ageMs > 0) {
		const when = new Date(Date.now() - ageMs);
		fs.utimesSync(lockPath(), when, when);
	}
}

after(() => {
	printTimingReport("Locking timings");
	cleanupAgentDir();
});

// ---------------------------------------------------------------------------
// Mutual exclusion
// ---------------------------------------------------------------------------

test("lock: concurrent processes never hold it at the same time", { timeout: LONG_TIMEOUT_MS }, async (t) => {
	const HOLD_MS = 400;
	const CHILDREN = 4;
	const log = scratch("holds.log");
	const barriers = path.join(path.dirname(log), "barriers");

	const reports = await timed(t, `${CHILDREN} processes contend for the lock`, () =>
		Promise.all(Array.from({ length: CHILDREN }, () => runChild("hold", barriers, log, String(HOLD_MS)))),
	);

	for (const report of reports) {
		assert.equal(report.acquired, true, `pid ${report.pid} never acquired: ${report.error ?? ""}`);
	}

	// File order in an append-only log is the ground truth, not each
	// process's own clock: a violation shorter than the clock skew between
	// two processes is invisible to timestamp comparison.
	const analysis = analyse(log);
	t.diagnostic(`log: ${analysis.enters} enters, ${analysis.exits} exits, max concurrent ${analysis.maxConcurrent}`);
	for (const violation of analysis.violations) {
		t.diagnostic(`VIOLATION ${violation.kind} @${violation.line}: ${violation.detail}`);
	}
	assert.deepEqual(analysis.violations, [], "the critical section was entered concurrently");
	assert.equal(analysis.enters, CHILDREN);
	assert.equal(analysis.maxConcurrent, 1);

	const intervals = reports
		.map((r) => ({ pid: r.pid, start: r.start as number, end: r.end as number }))
		.sort((a, b) => a.start - b.start);
	for (const interval of intervals) {
		t.diagnostic(
			`pid ${interval.pid} held for ${formatMs(interval.end - interval.start)} (+${interval.start - intervals[0].start}ms)`,
		);
	}
	// Serialised holds must add up: four 400ms holds cannot finish in 400ms.
	const span = Math.max(...intervals.map((i) => i.end)) - Math.min(...intervals.map((i) => i.start));
	assert.ok(span >= HOLD_MS * CHILDREN * 0.8, `total span ${span}ms is too short for ${CHILDREN} serialised holds`);

	assert.equal(fs.existsSync(lockPath()), false, "the lock file should be gone after release");
});

test("lock: a second acquire fails while the first is held", { timeout: 60_000 }, async (t) => {
	const first = await acquireLock({ timeoutMs: 5_000 });
	assert.ok(first, "the first acquire should succeed");
	try {
		const second = await timed(t, "contended acquire with a 700ms budget", () =>
			acquireLock({ timeoutMs: 700 }),
		);
		assert.equal(second, undefined, "the second acquire should have timed out");
	} finally {
		first.release();
	}
	assert.equal(fs.existsSync(lockPath()), false);
});

test("withLock: runs the body even when the lock cannot be taken", { timeout: 60_000 }, async (t) => {
	const blocker = await acquireLock({ timeoutMs: 5_000 });
	assert.ok(blocker);
	try {
		let ran = false;
		const locked = await timed(t, "withLock under contention", () =>
			withLock(
				async (wasLocked) => {
					ran = true;
					return wasLocked;
				},
				{ timeoutMs: 300 },
			),
		);
		assert.equal(ran, true, "a contended lock must not block the user's model switch");
		assert.equal(locked, false, "the body should be told it is running unlocked");
	} finally {
		blocker.release();
	}
});

// ---------------------------------------------------------------------------
// Breaking abandoned locks
// ---------------------------------------------------------------------------

test("lock: a lock held by a dead process is broken", { timeout: 60_000 }, async (t) => {
	const pid = await deadPid();
	assert.equal(isProcessAlive(pid), false, "the probe process should be gone");
	plantLock(pid);

	const handle = await timed(t, "acquire past a dead holder", () => acquireLock({ timeoutMs: 5_000 }));
	assert.ok(handle, "a dead holder's lock should be broken and taken");
	handle.release();
	assert.equal(fs.existsSync(lockPath()), false);
});

test("lock: a lock older than the stale window is broken even if alive", { timeout: 60_000 }, async (t) => {
	// Our own PID, so liveness says "alive"; only age can break this.
	plantLock(process.pid, "ancient", 60 * 60_000);

	const handle = await timed(t, "acquire past an expired lock", () =>
		acquireLock({ timeoutMs: 5_000, staleMs: 60_000 }),
	);
	assert.ok(handle, "an expired lock should be broken");
	handle.release();
});

test("lock: a lock written before the current boot is broken immediately", { timeout: 60_000 }, async (t) => {
	// Alive PID, fresh mtime — only the boot marker reveals it is impossible.
	fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
	fs.writeFileSync(
		lockPath(),
		JSON.stringify({
			v: 2,
			pid: process.pid,
			token: "previous-boot",
			at: Date.now(),
			host: os.hostname(),
			bootTime: bootTime() - 24 * 60 * 60_000,
		}),
	);

	const handle = await timed(t, "acquire past a pre-boot lock", () =>
		acquireLock({ timeoutMs: 3_000, staleMs: 60 * 60_000 }),
	);
	assert.ok(handle, "a lock from before the current boot cannot have a live owner");
	handle.release();
});

test("lock: an unreadable lock file is breakable, not a permanent deadlock", { timeout: 120_000 }, async (t) => {
	// Regression: `readLock()` returning undefined used to skip the break
	// branch entirely, so an empty or unrecognised lock file wedged every
	// session on the machine until someone deleted it by hand.
	const cases: [string, string | Buffer][] = [
		["empty", ""],
		["truncated json", '{"pid":1234,"tok'],
		["unknown record shape", '{"version":99,"whatever":true}'],
		["binary garbage", Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))],
	];

	for (const [label, content] of cases) {
		fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
		fs.writeFileSync(lockPath(), content);
		// Age it past the grace that protects a legitimate mid-write file.
		const when = new Date(Date.now() - UNREADABLE_GRACE_MS - 1_000);
		fs.utimesSync(lockPath(), when, when);

		const handle = await timed(t, `break an unreadable lock (${label})`, () =>
			acquireLock({ timeoutMs: 4_000, pollMs: 20 }),
		);
		assert.ok(handle, `an unreadable lock (${label}) must be breakable`);
		handle.release();
	}
});

test("lock: a freshly created, not-yet-written lock is respected", { timeout: 60_000 }, async (t) => {
	// The other half of the previous test: an empty file might be a holder
	// caught between open(wx) and write, so it must survive the grace.
	fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
	fs.writeFileSync(lockPath(), "");

	const handle = await timed(t, "acquire against a fresh empty lock", () =>
		acquireLock({ timeoutMs: 600, pollMs: 50 }),
	);
	assert.equal(handle, undefined, "an empty file inside the grace must not be broken");
	assert.equal(fs.existsSync(lockPath()), true, "and must not be deleted");
	fs.rmSync(lockPath(), { force: true });
});

test("lock: a crash between create and write does not wedge the next acquire", { timeout: 120_000 }, async (t) => {
	const log = scratch("crash.log");
	const barriers = path.join(path.dirname(log), "barriers");
	resetBarriers(barriers);

	await runChild("crash-after-create", barriers, log);
	assert.equal(fs.existsSync(lockPath()), true, "the child should have left an empty lock file");
	assert.equal(fs.readFileSync(lockPath(), "utf-8"), "", "and it should be empty");

	// Age it past the grace, then prove we recover rather than deadlocking.
	const when = new Date(Date.now() - UNREADABLE_GRACE_MS - 1_000);
	fs.utimesSync(lockPath(), when, when);
	const handle = await timed(t, "acquire after a crashed create", () =>
		acquireLock({ timeoutMs: 5_000, pollMs: 20 }),
	);
	assert.ok(handle, "a crash mid-write must not deadlock every future acquire");
	handle.release();
});

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

test("lock: release removes our lock even if the file reads back empty", async () => {
	// Regression: release() read the file, got undefined, concluded "someone
	// else owns it" and leaked the lock for the whole stale window.
	const handle = await acquireLock({ timeoutMs: 5_000 });
	assert.ok(handle);
	fs.writeFileSync(lockPath(), "");
	handle.release();
	assert.equal(fs.existsSync(lockPath()), false, "a transient read failure must not leak the lock");
});

test("lock: release leaves a lock that now belongs to someone else", async () => {
	const handle = await acquireLock({ timeoutMs: 5_000 });
	assert.ok(handle);
	// Somebody broke ours as stale and took it; theirs must survive.
	plantLock(4242, "someone-else");
	handle.release();
	assert.equal(fs.existsSync(lockPath()), true, "another holder's lock must survive our release");
	fs.rmSync(lockPath(), { force: true });
});

test("lock: isValid reports theft, and survives a transient unreadable file", async () => {
	const handle = await acquireLock({ timeoutMs: 5_000 });
	assert.ok(handle);
	assert.equal(handle.isValid(), true, "freshly acquired");

	// An unreadable file is not proof of theft — it may be our own, mid-read.
	fs.writeFileSync(lockPath(), "");
	assert.equal(handle.isValid(), true, "an unreadable file must not be read as theft");

	plantLock(4242, "thief");
	assert.equal(handle.isValid(), false, "a different token means we were robbed");
	assert.equal(handle.compromised, true);
	fs.rmSync(lockPath(), { force: true });
});

// ---------------------------------------------------------------------------
// The stale-break race
// ---------------------------------------------------------------------------

test(
	"lock: when a stale-break steals a live lock, the victim detects it",
	{ timeout: 120_000 },
	async (t) => {
		const log = scratch("toctou.log");
		const barriers = path.join(path.dirname(log), "barriers");
		resetBarriers(barriers);

		const stale = await deadPid();
		plantLock(stale, "stale-holder");

		// Both children see the same stale holder and both decide to break
		// it. Barriers force the interleaving where the thief's unlink lands
		// *after* the victim has legitimately acquired.
		const [victim, thief] = await timed(t, "forced stale-break interleaving", () =>
			Promise.all([
				runChild("toctou-victim", barriers, log, String(stale)),
				runChild("toctou-thief", barriers, log, String(stale)),
			]),
		);

		t.diagnostic(`victim: ${JSON.stringify(victim)}`);
		t.diagnostic(`thief:  ${JSON.stringify(thief)}`);
		assert.equal(victim.acquired, true, "the victim should have acquired legitimately");
		assert.equal(thief.acquired, true, "the thief should have broken in");

		const analysis = analyse(log);
		t.diagnostic(`log: max concurrent ${analysis.maxConcurrent}, ${analysis.violations.length} violation(s)`);

		// The race cannot be prevented by any filesystem lock in pure Node.
		// What must hold is the weaker, achievable property: if mutual
		// exclusion was actually violated, the victim noticed — which is what
		// lets evictThenPreload decline to unload anything.
		if (analysis.maxConcurrent > 1) {
			t.diagnostic("mutual exclusion was violated, as expected for this interleaving");
			assert.equal(
				victim.stillValid,
				false,
				"the victim must detect that its lock was stolen",
			);
			assert.equal(victim.compromised, true, "and must report itself compromised");
		} else {
			t.diagnostic("the interleaving did not overlap on this run; nothing to detect");
		}

		fs.rmSync(lockPath(), { force: true });
	},
);

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

test("claims: only live sessions from other ids are honoured", async (t) => {
	fs.rmSync(sessionsDir(), { recursive: true, force: true });
	const gone = await deadPid();

	const write = (id: string, modelKey: string, pid: number, updatedAt = Date.now(), host = os.hostname()) => {
		fs.mkdirSync(sessionsDir(), { recursive: true });
		fs.writeFileSync(
			path.join(sessionsDir(), `${id}.json`),
			JSON.stringify({ sessionId: id, pid, modelKey, updatedAt, host }),
		);
	};

	writeClaim("self", "model-self");
	write("other-live", "model-other", process.pid);
	write("other-dead", "model-dead", gone);
	write("other-stale", "model-stale", process.pid, Date.now() - CLAIM_STALE_MS - 1000);
	// Another machine's PID means nothing here, so this one rests on freshness.
	write("other-host", "model-remote", 999_999, Date.now(), "some-other-box");

	const claimed = claimedByOthers("self");
	t.diagnostic(`claimed by others: ${[...claimed].join(", ") || "(none)"}`);

	assert.equal(claimed.has("model-other"), true, "a live other session should be honoured");
	assert.equal(claimed.has("model-self"), false, "our own claim is not 'another session'");
	assert.equal(claimed.has("model-dead"), false, "a dead session claims nothing");
	assert.equal(claimed.has("model-stale"), false, "a session that stopped refreshing claims nothing");
	assert.equal(claimed.has("model-remote"), true, "a fresh claim from another host is honoured");
});

test("claims: dropping and pruning removes them", async () => {
	dropClaim("self");
	assert.equal(
		readClaims().some((claim) => claim.sessionId === "self"),
		false,
		"the dropped claim should be gone",
	);

	const pruned = pruneDeadClaims();
	assert.ok(pruned >= 1, "the dead session's claim should have been pruned");
	assert.equal(readClaims().some((claim) => claim.sessionId === "other-dead"), false);
	// A remote claim can never be judged dead from here, so it must survive.
	assert.equal(
		readClaims().some((claim) => claim.sessionId === "other-host"),
		true,
		"another machine's claim must not be pruned",
	);
});

test("isProcessAlive: true for us, false for an implausible pid", () => {
	assert.equal(isProcessAlive(process.pid), true);
	// The kernel hard-caps pid_max at PID_MAX_LIMIT (4194304) on Linux, so
	// this can never exist. Note 999_999 *can*: systemd raises pid_max to
	// 4194304, and a process was successfully forced onto that exact PID.
	assert.equal(isProcessAlive(999_999_999), false);
	// PID 0 means "my whole process group" to kill(2) and does not throw on
	// Linux, so the <= 0 guard is load-bearing rather than defensive.
	assert.equal(isProcessAlive(0), false);
	assert.equal(isProcessAlive(-1), false);
});

test("barrier: signal and wait are visible across the process boundary", { timeout: 60_000 }, async (t) => {
	// The race tests are only as trustworthy as the barrier they rest on.
	const log = scratch("park.log");
	const barriers = path.join(path.dirname(log), "barriers");
	resetBarriers(barriers);

	const child = runChild("park-after-create", barriers, log);
	// The child parks inside afterCreate, holding an empty lock file.
	await timed(t, "wait for the child to park", async () => {
		const deadline = Date.now() + 30_000;
		while (!fs.existsSync(path.join(barriers, "created"))) {
			if (Date.now() > deadline) throw new Error("child never signalled");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	});
	assert.equal(fs.existsSync(lockPath()), true, "the parked child holds the lock file");

	signal(barriers, "release-parked");
	const report = await child;
	assert.equal(report.acquired, true, "the child should complete its acquire once released");
	assert.equal(fs.existsSync(lockPath()), false, "and release it");
});
