/**
 * Append-only critical-section log, and the checker that decides whether
 * mutual exclusion actually held.
 *
 * Comparing per-process start/end timestamps — the obvious approach — is
 * both weaker and clock-sensitive: it cannot see a violation shorter than
 * the skew between two processes' clocks. File *order* under `O_APPEND` is
 * the ground truth instead, and it is exact.
 *
 * The atomicity this relies on was measured on this project's target
 * platform (Windows 11 / NTFS, 6-8 concurrent writers, records up to
 * 4211 B): zero interleaved or torn lines. It holds only under these rules,
 * which the helpers below enforce:
 *
 *   - the file is opened once with the "a" flag,
 *   - each record is exactly one `writeSync` of one pre-built buffer,
 *   - short writes are checked rather than assumed away.
 *
 * Never use `console.log` or a `WriteStream` here: both chunk and buffer,
 * and both will tear records under contention. The guarantee also does not
 * hold on NFS or SMB shares.
 */

import * as fs from "node:fs";

export type EventKind = "ENTER" | "EXIT" | "NOTE";

export interface LogRecord {
	ev: EventKind;
	/** Lock token, or any stable id for the holder. */
	token: string;
	pid: number;
	t: number;
	detail?: string;
}

/**
 * One open file descriptor per process, in append mode.
 *
 * Note the plain field assignments: Node runs this file through *strip-only*
 * type removal, which rejects TypeScript parameter properties
 * (`constructor(readonly file: string)`) outright.
 */
export class EventLog {
	readonly file: string;
	private readonly fd: number;

	constructor(file: string) {
		this.file = file;
		this.fd = fs.openSync(file, "a");
	}

	write(record: Omit<LogRecord, "t">): void {
		const line = Buffer.from(`${JSON.stringify({ ...record, t: Date.now() })}\n`, "utf-8");
		const written = fs.writeSync(this.fd, line);
		// A short write would silently corrupt the log and turn a real
		// violation into a parse error. Fail loudly instead.
		if (written !== line.length) {
			throw new Error(`short write to event log: ${written} of ${line.length} bytes`);
		}
	}

	enter(token: string, detail?: string): void {
		this.write({ ev: "ENTER", token, pid: process.pid, detail });
	}

	exit(token: string, detail?: string): void {
		this.write({ ev: "EXIT", token, pid: process.pid, detail });
	}

	note(token: string, detail: string): void {
		this.write({ ev: "NOTE", token, pid: process.pid, detail });
	}

	close(): void {
		fs.closeSync(this.fd);
	}
}

export interface Violation {
	kind: "overlap" | "exit-without-enter" | "corrupt-line";
	line: number;
	detail: string;
}

export interface LogAnalysis {
	records: LogRecord[];
	violations: Violation[];
	enters: number;
	exits: number;
	/** Highest number of tokens simultaneously inside the critical section. */
	maxConcurrent: number;
}

/**
 * Walk the log in file order and check that at most one token is ever inside
 * the critical section.
 */
export function analyse(file: string): LogAnalysis {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return { records: [], violations: [], enters: 0, exits: 0, maxConcurrent: 0 };
	}

	const records: LogRecord[] = [];
	const violations: Violation[] = [];
	const inside = new Set<string>();
	let maxConcurrent = 0;
	let enters = 0;
	let exits = 0;

	const lines = raw.split("\n");
	for (const [index, text] of lines.entries()) {
		if (text.trim() === "") continue;
		let record: LogRecord;
		try {
			record = JSON.parse(text) as LogRecord;
		} catch {
			// A torn line means the append guarantee was violated, which
			// invalidates the whole run — report it rather than skipping.
			violations.push({ kind: "corrupt-line", line: index + 1, detail: text.slice(0, 120) });
			continue;
		}
		records.push(record);

		if (record.ev === "ENTER") {
			enters++;
			if (inside.size > 0) {
				violations.push({
					kind: "overlap",
					line: index + 1,
					detail: `${record.token} (pid ${record.pid}) entered while [${[...inside].join(", ")}] held the lock`,
				});
			}
			inside.add(record.token);
			maxConcurrent = Math.max(maxConcurrent, inside.size);
		} else if (record.ev === "EXIT") {
			exits++;
			if (!inside.has(record.token)) {
				violations.push({
					kind: "exit-without-enter",
					line: index + 1,
					detail: `${record.token} (pid ${record.pid}) exited without entering`,
				});
			}
			inside.delete(record.token);
		}
	}

	return { records, violations, enters, exits, maxConcurrent };
}

/** Deterministic PRNG, so a failing stress run can be replayed from its seed. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
