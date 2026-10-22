import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { managedPiRoot } from "../support/find-pi.ts";

const PACKAGE_PARTS = ["node_modules", "@earendil-works", "pi-coding-agent"];

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-pi-test-"));
	scratch.push(dir);
	return dir;
}

/** Put a fake pi package at `<install>/releases/<version>/node_modules/@earendil-works/pi-coding-agent`. */
function plant(agentDir: string, version: string): string {
	const pkg = path.join(agentDir, "install", "releases", version, ...PACKAGE_PARTS);
	fs.mkdirSync(pkg, { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), "{}");
	return pkg;
}

/** A fake managed install: `<agent>/install/{current-version,releases/<v>/…}`. */
function fakeAgentDir(version: string | undefined, installed: string[]): string {
	const agentDir = tempDir();
	fs.mkdirSync(path.join(agentDir, "install"), { recursive: true });
	if (version !== undefined) fs.writeFileSync(path.join(agentDir, "install", "current-version"), `${version}\n`);
	for (const v of installed) plant(agentDir, v);
	return agentDir;
}

test("managedPiRoot follows current-version, not the newest release", () => {
	// 1.4.0 is the newest and sorts last, so "pick the latest" would answer 1.4.0.
	const agentDir = fakeAgentDir("1.3.0", ["1.3.0", "1.4.0"]);
	assert.equal(managedPiRoot(agentDir), path.join(agentDir, "install", "releases", "1.3.0", ...PACKAGE_PARTS));
});

test("managedPiRoot is undefined without an install", () => {
	assert.equal(managedPiRoot(tempDir()), undefined);
});

test("managedPiRoot is undefined when current-version points at a missing release", () => {
	assert.equal(managedPiRoot(fakeAgentDir("2.0.0", ["1.4.0"])), undefined);
});

test("managedPiRoot refuses a current-version that would escape the releases directory", () => {
	for (const version of ["..", ".", "../x", "a/b", ""]) {
		// A real package sits wherever this version would resolve to, so the only
		// thing that can produce `undefined` is the validation itself. Without a
		// planted target the test would pass on any implementation.
		const agentDir = fakeAgentDir(version, []);
		const target = plant(agentDir, version);
		assert.ok(fs.existsSync(path.join(target, "package.json")), `fixture for ${JSON.stringify(version)}`);
		assert.equal(managedPiRoot(agentDir), undefined, JSON.stringify(version));
	}
});

/**
 * `findPiRoot()` as a fresh process sees it, from a working directory with no
 * `node_modules`, so the project-local lookup misses.
 *
 * The environment is built from scratch around `overrides`: the machine running
 * this test may itself be inside a pi session (`PI_MANAGED_INSTALL_ROOT`), and
 * on Windows `PATH` is spelled `Path` in `process.env`, so a plain spread plus
 * `PATH:` would carry two spellings of the same variable.
 */
function findPiRootInChild(overrides: Record<string, string>): string {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/^(path|pi_managed_install_root|pi_coding_agent_dir)$/i.test(key)) continue;
		env[key] = value;
	}
	Object.assign(env, overrides);

	const module = pathToFileURL(path.resolve(import.meta.dirname, "../support/find-pi.ts")).href;
	return execFileSync(
		process.execPath,
		["--input-type=module", "-e", `import(${JSON.stringify(module)}).then((m) => console.log(m.findPiRoot()))`],
		{ cwd: tempDir(), encoding: "utf-8", env, stdio: ["ignore", "pipe", "ignore"] },
	).trim();
}

const originalPath = process.env.PATH ?? process.env.Path ?? "";

test("findPiRoot uses the launcher on PATH even when PI_CODING_AGENT_DIR points elsewhere", () => {
	// The integration harness redirects PI_CODING_AGENT_DIR to a temp dir at
	// import time; the real install must stay findable through the launcher.
	const real = fakeAgentDir("1.4.0", ["1.4.0"]);
	fs.mkdirSync(path.join(real, "bin"), { recursive: true });
	fs.writeFileSync(path.join(real, "bin", "pi-launcher.js"), "");
	const decoy = fakeAgentDir("1.4.0", ["1.4.0"]);

	const found = findPiRootInChild({
		PATH: `${path.join(real, "bin")}${path.delimiter}${originalPath}`,
		PI_CODING_AGENT_DIR: decoy,
	});

	assert.equal(found, path.join(real, "install", "releases", "1.4.0", ...PACKAGE_PARTS));
});

test("findPiRoot follows PI_MANAGED_INSTALL_ROOT when the launcher is not on PATH", () => {
	// Tests run from inside a pi session inherit this variable from the launcher
	// even if its bin/ directory never made it onto PATH.
	const real = fakeAgentDir("1.4.0", ["1.4.0"]);
	const decoy = fakeAgentDir("1.4.0", ["1.4.0"]);

	const found = findPiRootInChild({
		PATH: originalPath,
		PI_MANAGED_INSTALL_ROOT: path.join(real, "install"),
		PI_CODING_AGENT_DIR: decoy,
	});

	assert.equal(found, path.join(real, "install", "releases", "1.4.0", ...PACKAGE_PARTS));
});
