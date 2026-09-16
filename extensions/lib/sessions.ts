/**
 * Multi-session safety.
 *
 * One LM Studio instance is shared by everything on the machine: several pi
 * sessions, maybe an OpenCode window too. Two problems follow, and this
 * module handles both.
 *
 * **Claims** — each pi session publishes the model it is using to
 * `<extensionDir>/sessions/<id>.json`. Before evicting, we read the other
 * sessions' claims and leave those models resident, so switching models in
 * one window no longer pulls the model out from under another. A claim only
 * counts while its process is alive, so a crashed session protects nothing.
 *
 * **A lock** — `<extensionDir>/lms.lock` serialises evict-then-load
 * sequences across processes. Without it two sessions can interleave into
 * "unload everything / unload everything / load A / load B" and end up with
 * both models resident, which is the exact thing the extension exists to
 * prevent.
 *
 * Both are advisory and best-effort by design: every failure path here ends
 * with "carry on anyway", because a stuck lock file must never be able to
 * stop a user from switching models.
 *
 * ## What this lock does and does not guarantee
 *
 * It cannot guarantee mutual exclusion, and no filesystem lock in pure Node
 * can. Breaking an abandoned lock takes two syscalls — decide it is stale,
 * then unlink it — and nothing makes that pair atomic, so a breaker can
 * always delete a lock that somebody else legitimately acquired in between.
 * (Kleppmann's "How to do distributed locking" is the canonical statement of
 * why an expiry re-check cannot close this; `proper-lockfile` has the same
 * hole and answers it the same way we do.) Node core offers no `flock` —
 * nodejs/node#54446 was closed as not planned — so there is no OS-owned
 * primitive to fall back on.
 *
 * What it does instead, in order of importance:
 *
 * 1. **Makes breaking rare.** A heartbeat keeps a live lock's mtime fresh,
 *    which lets the stale window be 30 s instead of the multiple minutes a
 *    model load needs. Fewer break decisions, fewer chances to race.
 * 2. **Detects theft.** The holder re-checks its token on every heartbeat and
 *    sets `compromised`. `evictThenPreload` checks `isValid()` immediately
 *    before it unloads anything, which shrinks the exposure from "the whole
 *    multi-minute load" to "one token read" and turns a silent double
 *    eviction into one we can decline to perform.
 * 3. **Never wedges.** Every unreadable or unrecognised lock file is
 *    breakable after a short grace, so a crash mid-write or a future version
 *    with a different record shape cannot deadlock every session on the
 *    machine.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extensionDir } from "./config.ts";

/** One live pi session's hold on a model. */
export interface SessionClaim {
	sessionId: string;
	pid: number;
	/** Bare `lms` model key, or undefined when the session is on a non-LM-Studio model. */
	modelKey?: string;
	/** Epoch ms of the last refresh; the staleness backstop for PID reuse. */
	updatedAt: number;
	host?: string;
}

/**
 * A claim from a process that is alive but has not refreshed in this long is
 * ignored. Only a backstop against PID reuse — liveness is the real signal —
 * so it is set well beyond any plausible gap between refreshes.
 */
export const CLAIM_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * A held lock whose mtime is older than this is treated as abandoned.
 *
 * Short *because* of the heartbeat: the holder touches the file every
 * `HEARTBEAT_MS`, so a long model load keeps its lock fresh without needing
 * a long window. Before the heartbeat existed this was 15 minutes, which
 * meant a crashed session wedged every other session for 15 minutes.
 */
export const LOCK_STALE_MS = 30_000;

/** How often a holder refreshes its lock's mtime and re-checks its token. */
export const HEARTBEAT_MS = 5_000;

/**
 * How long an unreadable lock file is tolerated before it is broken.
 *
 * `open(wx)` then `write` leaves a ~300 µs window where the file exists but
 * is empty; a legitimate holder closes it far inside this grace. Anything
 * still unparseable after 5 s is wreckage — a crash mid-write, a failed
 * write, or a record shape from a different version of this extension — and
 * must not be allowed to wedge the machine.
 */
export const UNREADABLE_GRACE_MS = 5_000;

/** Boot times computed in different processes agree to ~13 ms; allow slack. */
const BOOT_TIME_TOLERANCE_MS = 5_000;

/** An mtime further in the future than this means the clock moved, not us. */
const FUTURE_MTIME_TOLERANCE_MS = 60_000;

const DEFAULT_POLL_MS = 100;
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/** Current record shape. Older or newer records are treated as unreadable. */
const LOCK_RECORD_VERSION = 2;

export function sessionsDir(): string {
	return path.join(extensionDir(), "sessions");
}

export function lockPath(): string {
	return path.join(extensionDir(), "lms.lock");
}

/**
 * Identity for this pi process. The PID alone would be ambiguous after
 * reuse, so a random suffix makes each run distinguishable.
 */
export function newSessionId(): string {
	return `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Is a process still running? EPERM means "exists, not ours to signal". */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Epoch ms of the last boot. Agrees across processes to within a few ms, so
 * a lock recorded before the current boot is definitively dead however alive
 * its PID looks now.
 */
export function bootTime(): number {
	return Date.now() - os.uptime() * 1000;
}

function claimPath(sessionId: string): string {
	// Session ids are generated locally, but never let one escape the folder.
	return path.join(sessionsDir(), `${path.basename(sessionId)}.json`);
}

/** Publish (or refresh) this session's hold on `modelKey`. */
export function writeClaim(sessionId: string, modelKey: string | undefined): void {
	const claim: SessionClaim = {
		sessionId,
		pid: process.pid,
		modelKey,
		updatedAt: Date.now(),
		host: os.hostname(),
	};
	try {
		fs.mkdirSync(sessionsDir(), { recursive: true });
		fs.writeFileSync(claimPath(sessionId), `${JSON.stringify(claim, null, "\t")}\n`, "utf-8");
	} catch {
		// A claim we cannot write just means we protect nothing. Not fatal.
	}
}

/** Drop this session's claim, so its model stops being protected. */
export function dropClaim(sessionId: string): void {
	try {
		fs.rmSync(claimPath(sessionId), { force: true });
	} catch {
		// Left behind; the liveness check will discount it once we exit.
	}
}

/** Every claim currently on disk, malformed files skipped. */
export function readClaims(): SessionClaim[] {
	let names: string[];
	try {
		names = fs.readdirSync(sessionsDir());
	} catch {
		return []; // No directory yet — nobody has claimed anything.
	}
	const claims: SessionClaim[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(sessionsDir(), name), "utf-8"));
			if (parsed && typeof parsed === "object" && typeof parsed.pid === "number") {
				claims.push(parsed as SessionClaim);
			}
		} catch {
			// Half-written or hand-mangled file; ignore it.
		}
	}
	return claims;
}

export interface LivenessOptions {
	now?: number;
	isAlive?: (pid: number) => boolean;
}

/**
 * Claims whose owning process is still running and still refreshing.
 *
 * A claim from another host is never subjected to the PID check — the number
 * would be meaningless — so it rests on staleness alone. This matters when
 * the agent directory is on a synced or shared filesystem.
 */
export function liveClaims(options: LivenessOptions = {}): SessionClaim[] {
	const now = options.now ?? Date.now();
	const alive = options.isAlive ?? isProcessAlive;
	const here = os.hostname();
	return readClaims().filter((claim) => {
		if (now - claim.updatedAt >= CLAIM_STALE_MS) return false;
		if (claim.host !== undefined && claim.host !== here) return true;
		return alive(claim.pid);
	});
}

/**
 * Model keys held by *other* live sessions — the set an eviction must spare.
 * Empty when this is the only session, which lets the caller take the fast
 * `lms unload --all` path.
 */
export function claimedByOthers(sessionId: string, options: LivenessOptions = {}): Set<string> {
	const keys = new Set<string>();
	for (const claim of liveClaims(options)) {
		if (claim.sessionId === sessionId) continue;
		if (claim.modelKey) keys.add(claim.modelKey);
	}
	return keys;
}

/** Remove claims whose process is gone. Housekeeping; failures are ignored. */
export function pruneDeadClaims(options: LivenessOptions = {}): number {
	const alive = options.isAlive ?? isProcessAlive;
	const here = os.hostname();
	let pruned = 0;
	for (const claim of readClaims()) {
		// Never prune another machine's claim: we cannot judge its liveness.
		if (claim.host !== undefined && claim.host !== here) continue;
		if (alive(claim.pid)) continue;
		try {
			fs.rmSync(claimPath(claim.sessionId), { force: true });
			pruned++;
		} catch {
			// Ignore; it will be retried next session.
		}
	}
	return pruned;
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

interface LockRecord {
	v: number;
	pid: number;
	token: string;
	at: number;
	host: string;
	bootTime: number;
}

/**
 * @internal Test seam. Every hook is synchronous by design, so nothing can
 * introduce an `await` point into the critical path through it, and the
 * whole object is unreachable unless a caller passes `hooks`. Do not use
 * outside `tests/`.
 */
export interface LockHooks {
	beforeCreate?(): void;
	/** Between `open(wx)` and the write — the file exists but is empty. */
	afterCreate?(): void;
	afterWrite?(): void;
	/** Between deciding a holder is stale and unlinking it. */
	beforeBreakUnlink?(holder: LockRecord | undefined): void;
	afterBreakUnlink?(): void;
	beforeReleaseUnlink?(): void;
	onPoll?(iteration: number): void;
}

export interface LockHandle {
	token: string;
	/** Set when a heartbeat found the lock file no longer ours. */
	readonly compromised: boolean;
	/** Re-read the lock file: is it still ours? Cheap; call before destruction. */
	isValid(): boolean;
	release(): void;
}

/** Reads and validates the lock record. Undefined means "cannot be trusted". */
function readLock(): LockRecord | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath(), "utf-8"));
		if (
			parsed &&
			typeof parsed.pid === "number" &&
			typeof parsed.token === "string" &&
			parsed.v === LOCK_RECORD_VERSION
		) {
			return parsed as LockRecord;
		}
	} catch {
		// Missing, empty, being written right now, or a shape we don't know.
	}
	return undefined;
}

function lockMtimeMs(): number | undefined {
	try {
		return fs.statSync(lockPath()).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Age of the lock file, preferring the filesystem's mtime over the timestamp
 * inside the record: the heartbeat refreshes mtime, and a holder cannot
 * forge it.
 */
function lockAgeMs(holder: LockRecord | undefined, now: number): number | undefined {
	const mtime = lockMtimeMs();
	const stamp = mtime ?? holder?.at;
	if (stamp === undefined) return undefined;
	// A timestamp far in the future means the clock moved, not that the lock
	// is eternally fresh. Treat it as age zero but let the caller's timeout
	// eventually win, rather than returning a large negative number.
	if (stamp > now + FUTURE_MTIME_TOLERANCE_MS) return 0;
	return now - stamp;
}

function sleep(ms: number): Promise<void> {
	// Deliberately a *referenced* timer. An unref'd poll would let Node exit
	// while a process is still waiting its turn, silently dropping the
	// eviction it was queued to perform.
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export interface AcquireOptions extends LivenessOptions {
	/** Give up after this long and resolve undefined. */
	timeoutMs?: number;
	staleMs?: number;
	pollMs?: number;
	/** Disable the mtime heartbeat (tests that want a lock to go stale). */
	heartbeat?: boolean;
	heartbeatMs?: number;
	/** @internal tests only */
	hooks?: LockHooks;
}

/**
 * Decide whether a lock we failed to create can be taken from its holder.
 *
 * Returns a reason string when the lock should be broken, or undefined to
 * keep waiting. The unreadable case is the important one: before it existed,
 * an empty or unrecognised lock file wedged every session on the machine
 * until someone deleted it by hand.
 */
function breakReason(
	holder: LockRecord | undefined,
	now: number,
	staleMs: number,
	alive: (pid: number) => boolean,
): string | undefined {
	const age = lockAgeMs(holder, now);

	if (!holder) {
		if (age === undefined) return "lock file vanished";
		return age > UNREADABLE_GRACE_MS
			? `unreadable lock file, ${Math.round(age)}ms old`
			: undefined;
	}

	// A lock written before the current boot cannot have a live owner,
	// whatever the PID table says now.
	if (
		typeof holder.bootTime === "number" &&
		Math.abs(holder.bootTime - bootTime()) > BOOT_TIME_TOLERANCE_MS
	) {
		return "lock predates the current boot";
	}

	if (age !== undefined && age > staleMs) return `stale by ${Math.round(age - staleMs)}ms`;

	// Another machine's PID means nothing to us; staleness alone decides.
	if (holder.host !== undefined && holder.host !== os.hostname()) return undefined;

	return alive(holder.pid) ? undefined : `holder pid ${holder.pid} is gone`;
}

/**
 * Take the cross-process lock, or resolve undefined if it stays held past
 * `timeoutMs`.
 *
 * `open(..., "wx")` is the atomic primitive: exactly one process can create
 * the file, so exactly one wins each round. At most **one** break is
 * performed per call — the rule `proper-lockfile` uses — so two processes
 * cannot cascade into repeatedly breaking each other.
 */
export async function acquireLock(options: AcquireOptions = {}): Promise<LockHandle | undefined> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleMs = options.staleMs ?? LOCK_STALE_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const alive = options.isAlive ?? isProcessAlive;
	const hooks = options.hooks;
	const token = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + timeoutMs;
	let breaksRemaining = 1;
	let iteration = 0;

	for (;;) {
		try {
			fs.mkdirSync(extensionDir(), { recursive: true });
			const record: LockRecord = {
				v: LOCK_RECORD_VERSION,
				pid: process.pid,
				token,
				at: Date.now(),
				host: os.hostname(),
				bootTime: bootTime(),
			};
			hooks?.beforeCreate?.();
			const fd = fs.openSync(lockPath(), "wx");
			hooks?.afterCreate?.();
			try {
				fs.writeFileSync(fd, JSON.stringify(record));
			} finally {
				fs.closeSync(fd);
			}
			hooks?.afterWrite?.();
			return makeHandle(token, options);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
		}

		const holder = readLock();
		const reason = breakReason(holder, Date.now(), staleMs, alive);
		if (reason !== undefined && breaksRemaining > 0) {
			breaksRemaining--;
			// Re-check the token immediately before unlinking so we are less
			// likely to delete a lock somebody just legitimately took. This
			// narrows the window; it cannot close it (see the header note).
			const current = readLock();
			if (current?.token === holder?.token) {
				hooks?.beforeBreakUnlink?.(holder);
				try {
					fs.rmSync(lockPath(), { force: true });
				} catch {
					// Someone else got there first; just retry.
				}
				hooks?.afterBreakUnlink?.();
			}
			continue;
		}

		if (Date.now() >= deadline) return undefined;
		hooks?.onPoll?.(iteration++);
		// Jitter decorrelates waiters. Without it every session that wakes
		// from a laptop suspend polls in the same instant and they all decide
		// the lock is stale together — the worst case for the break race.
		await sleep(pollMs * (0.5 + Math.random()));
	}
}

function makeHandle(token: string, options: AcquireOptions): LockHandle {
	const hooks = options.hooks;
	let compromised = false;
	let released = false;
	/** mtime we last knew the file to carry, for the release decision. */
	let lastWriteMs = lockMtimeMs() ?? Date.now();

	const isValid = (): boolean => {
		if (released || compromised) return false;
		const current = readLock();
		// An unreadable file is not proof of theft — it may be our own file
		// caught mid-read — so only a *different* token counts against us.
		if (current && current.token !== token) {
			compromised = true;
			return false;
		}
		return true;
	};

	let timer: NodeJS.Timeout | undefined;
	if (options.heartbeat !== false) {
		timer = setInterval(() => {
			if (released) return;
			if (!isValid()) return;
			try {
				const now = new Date();
				fs.utimesSync(lockPath(), now, now);
				lastWriteMs = now.getTime();
			} catch {
				// The file went away; isValid() will notice on the next call.
			}
		}, options.heartbeatMs ?? HEARTBEAT_MS);
		// Unref'd, unlike the poll timer: a heartbeat must never be the
		// reason a process stays alive.
		timer.unref?.();
	}

	return {
		token,
		get compromised() {
			return compromised;
		},
		isValid,
		release() {
			if (released) return;
			released = true;
			if (timer) clearInterval(timer);
			hooks?.beforeReleaseUnlink?.();

			const current = readLock();
			if (current) {
				// Somebody else's lock — leave it alone.
				if (current.token !== token) return;
			} else {
				// Unreadable. Deleting blindly could destroy a lock another
				// process created microseconds ago, so use mtime to tell
				// "our own file, transiently unreadable" from "someone
				// else's, freshly made".
				const mtime = lockMtimeMs();
				if (mtime === undefined) return; // Already gone.
				if (mtime > lastWriteMs + 1_000) return;
			}
			try {
				fs.rmSync(lockPath(), { force: true });
			} catch {
				// Next acquirer will break it once the grace elapses.
			}
		},
	};
}

/**
 * Run `fn` under the lock. When the lock cannot be taken in time, `fn` runs
 * anyway: a contended lock is a reason to be careful, not a reason to refuse
 * the user's model switch. `fn` receives the handle so it can check
 * `isValid()` before doing anything destructive.
 */
export async function withLock<T>(
	fn: (locked: boolean, handle?: LockHandle) => Promise<T>,
	options: AcquireOptions = {},
): Promise<T> {
	const handle = await acquireLock(options);
	try {
		return await fn(handle !== undefined, handle);
	} finally {
		handle?.release();
	}
}
