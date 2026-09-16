/**
 * Child process for locking.test.ts.
 *
 * Runs one named scenario and prints a single JSON line describing what
 * happened. Real processes, because an in-process test would pass even if
 * the lock were a module-level boolean — which is exactly the bug that
 * matters when a second pi window is open.
 *
 * The interesting scenarios are steered by *barriers*, not sleeps: a barrier
 * expresses the ordering the test actually needs ("wait until the other
 * process has created its lock"), so the interleaving is reproduced
 * deterministically instead of hopefully. `SIGSTOP` would be the obvious
 * alternative and does not exist on Windows.
 *
 * Not named `*.test.ts` so the runner does not pick it up as a suite.
 *
 * Usage: lock-child.ts <scenario> <barrierDir> <logPath> [arg...]
 */

import { acquireLock } from "../../extensions/lib/sessions.ts";
import { signal, waitFor } from "../support/barrier.ts";
import { EventLog } from "../support/event-log.ts";

const [scenario, barrierDir, logPath, ...rest] = process.argv.slice(2);

const report = (fields: Record<string, unknown>) => {
	console.log(JSON.stringify({ scenario, pid: process.pid, ...fields }));
};

switch (scenario) {
	/** Plain acquire / hold / release, for the mutual-exclusion test. */
	case "hold": {
		const holdMs = Number(rest[0] ?? 300);
		const timeoutMs = Number(rest[1] ?? 60_000);
		const log = new EventLog(logPath);
		const handle = await acquireLock({ timeoutMs });
		if (!handle) {
			report({ acquired: false });
			break;
		}
		log.enter(handle.token);
		const start = Date.now();
		await new Promise((resolve) => setTimeout(resolve, holdMs));
		const end = Date.now();
		log.exit(handle.token);
		log.close();
		handle.release();
		report({ acquired: true, token: handle.token, start, end });
		break;
	}

	/**
	 * Die between `open(wx)` and the write, leaving an empty lock file — the
	 * state that used to wedge every session on the machine forever.
	 */
	case "crash-after-create": {
		await acquireLock({
			timeoutMs: 30_000,
			hooks: {
				afterCreate() {
					signal(barrierDir, "created");
					process.exit(1);
				},
			},
		});
		report({ acquired: true, note: "should not be reached" });
		break;
	}

	/** Hold the lock file open-but-empty until told to continue. */
	case "park-after-create": {
		const handle = await acquireLock({
			timeoutMs: 30_000,
			hooks: {
				afterCreate() {
					signal(barrierDir, "created");
					waitFor(barrierDir, "release-parked", 30_000);
				},
			},
		});
		report({ acquired: handle !== undefined, token: handle?.token });
		handle?.release();
		break;
	}

	/**
	 * The thief in the stale-break race. Decides the stale holder must go,
	 * announces that, then waits until the victim has taken the lock for
	 * real before unlinking — deleting a live lock.
	 */
	case "toctou-thief": {
		const deadPid = Number(rest[0]);
		const log = new EventLog(logPath);
		const handle = await acquireLock({
			timeoutMs: 30_000,
			isAlive: (pid) => pid !== deadPid,
			hooks: {
				beforeBreakUnlink() {
					signal(barrierDir, "thief.decided");
					waitFor(barrierDir, "victim.created", 30_000);
				},
			},
		});
		if (!handle) {
			report({ acquired: false });
			break;
		}
		log.enter(handle.token, "thief");
		signal(barrierDir, "thief.entered");
		await new Promise((resolve) => setTimeout(resolve, 300));
		log.exit(handle.token, "thief");
		log.close();
		handle.release();
		report({ acquired: true, token: handle.token, compromised: handle.compromised });
		break;
	}

	/**
	 * The victim. Breaks the same stale holder, acquires legitimately, then
	 * checks whether it still owns the lock after the thief has run. That
	 * check is the mitigation: the race cannot be prevented, but the victim
	 * can notice and decline to do anything destructive.
	 */
	case "toctou-victim": {
		const deadPid = Number(rest[0]);
		const log = new EventLog(logPath);
		const handle = await acquireLock({
			timeoutMs: 30_000,
			isAlive: (pid) => pid !== deadPid,
			hooks: {
				beforeBreakUnlink() {
					waitFor(barrierDir, "thief.decided", 30_000);
				},
				afterWrite() {
					signal(barrierDir, "victim.created");
				},
			},
		});
		if (!handle) {
			report({ acquired: false });
			break;
		}
		log.enter(handle.token, "victim");
		// Give the thief its chance to steal the lock out from under us.
		waitFor(barrierDir, "thief.entered", 30_000);
		const stillValid = handle.isValid();
		log.exit(handle.token, "victim");
		log.close();
		handle.release();
		report({
			acquired: true,
			token: handle.token,
			stillValid,
			compromised: handle.compromised,
		});
		break;
	}

	default:
		report({ error: `unknown scenario: ${scenario}` });
		process.exit(2);
}
