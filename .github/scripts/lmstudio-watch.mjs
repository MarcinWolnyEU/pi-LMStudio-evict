// Background sampler for diagnosing flaky runs: logs a line whenever
// ~/.lmstudio/bin/lms changes (size, mtime, ctime, inode) or the set of
// llmster processes changes, plus a heartbeat every 30s. A CI step starts it
// before the tests; the failure path uploads its log next to LM Studio's own.
//
// Usage: node lmstudio-watch.mjs <log-file>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logFile = process.argv[2];
const exe = process.platform === "win32" ? "lms.exe" : "lms";
const lms = path.join(os.homedir(), ".lmstudio", "bin", exe);
const t0 = Date.now();

function log(message) {
	const line = `${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${message}\n`;
	if (logFile) fs.appendFileSync(logFile, line);
	else process.stdout.write(line);
}

function binary() {
	try {
		const s = fs.statSync(lms, { bigint: true });
		return `size=${s.size} ino=${s.ino} mtime=${s.mtime.toISOString()} ctime=${s.ctime.toISOString()}`;
	} catch (error) {
		return `unreadable (${error.code})`;
	}
}

function daemonPids() {
	try {
		if (process.platform === "win32") {
			const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq llmster.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
			return [...out.matchAll(/"llmster\.exe","(\d+)"/g)].map((m) => m[1]).join(",") || "none";
		}
		const out = execFileSync("ps", ["-eo", "pid=,comm="], { encoding: "utf8" });
		const pids = out
			.split("\n")
			.map((l) => l.trim().split(/\s+/))
			.filter(([, comm]) => comm === "llmster")
			.map(([pid]) => pid);
		return pids.join(",") || "none";
	} catch {
		return "unknown";
	}
}

let lastBinary = "";
let lastPids = "";
let lastBeat = 0;
log("watcher started");
for (;;) {
	const b = binary();
	if (b !== lastBinary) {
		log(`lms binary: ${b}`);
		lastBinary = b;
	}
	const p = daemonPids();
	if (p !== lastPids) {
		log(`llmster pids: ${p}`);
		lastPids = p;
	}
	if (Date.now() - lastBeat > 30_000) {
		lastBeat = Date.now();
		log("heartbeat");
	}
	await new Promise((resolve) => setTimeout(resolve, 1000));
}
