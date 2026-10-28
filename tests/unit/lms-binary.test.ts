/**
 * `lmsBinary()` resolution order. Each case runs in a fresh child process,
 * because the result is memoised for the life of a process — which is also
 * what a pi session sees.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const LMS_MODULE = path.resolve(import.meta.dirname, "../../extensions/lib/lms.ts");
const EXE = process.platform === "win32" ? "lms.exe" : "lms";

/** Resolve `lmsBinary()` in a child with exactly this environment. */
function resolveIn(env: Record<string, string>): string {
	const script = `import(${JSON.stringify(LMS_MODULE)}).then((m) => process.stdout.write(m.lmsBinary()))`;
	return execFileSync(process.execPath, ["-e", script], { env, encoding: "utf-8" }).trim();
}

/** An executable stand-in for `lms` at `<dir>/<EXE>`. */
function fakeLms(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, EXE);
	fs.writeFileSync(file, "");
	fs.chmodSync(file, 0o755);
	return file;
}

test("lmsBinary: finds LM Studio's own bin dir when PATH has no lms (GUI-launched pi on macOS)", (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lms-home-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	const expected = fakeLms(path.join(home, ".lmstudio", "bin"));
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lms-path-"));
	t.after(() => fs.rmSync(empty, { recursive: true, force: true }));

	assert.equal(resolveIn({ HOME: home, USERPROFILE: home, PATH: empty }), expected);
});

test("lmsBinary: PATH wins over the install dir, and LMS_PATH wins over both", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lms-order-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	fakeLms(path.join(home, ".lmstudio", "bin"));
	const onPath = fakeLms(path.join(root, "path"));
	const explicit = fakeLms(path.join(root, "explicit"));
	const env = { HOME: home, USERPROFILE: home, PATH: path.join(root, "path") };

	assert.equal(resolveIn(env), onPath);
	assert.equal(resolveIn({ ...env, LMS_PATH: explicit }), explicit);
});

test("lmsBinary: skips a directory named lms on PATH", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lms-dir-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const expected = fakeLms(path.join(home, ".lmstudio", "bin"));
	// A directory is "executable" to accessSync(X_OK); spawning it is EACCES.
	fs.mkdirSync(path.join(root, "path", EXE), { recursive: true });

	assert.equal(resolveIn({ HOME: home, USERPROFILE: home, PATH: path.join(root, "path") }), expected);
});

test("lmsBinary: falls back to the bare name when nothing is found", (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lms-none-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));

	assert.equal(resolveIn({ HOME: home, USERPROFILE: home, PATH: home }), "lms");
});
