/**
 * Locate the installed pi package.
 *
 * pi is a *peer* dependency, so in a bare checkout it is normally installed
 * globally rather than in `node_modules` here, and "globally" means a
 * different directory on every platform and setup:
 *
 *   Windows / nvm4w   <node dir>\node_modules
 *   Unix, default     <node dir>/../lib/node_modules   (/usr/local, /usr)
 *   custom npm prefix  wherever `npm config set prefix` pointed it
 *
 * The last one is the standard sudo-free Linux setup (`npm config set prefix
 * ~/.npm-global`) and is not derivable from `process.execPath` at all, so we
 * ask npm directly — but only after the cheap guesses miss, because
 * shelling out to npm costs the better part of a second.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PACKAGE = path.join("@earendil-works", "pi-coding-agent");

/** `npm root -g`, or undefined when npm is absent or slow to answer. */
function npmGlobalRoot(): string | undefined {
	try {
		return execFileSync("npm", ["root", "-g"], {
			encoding: "utf-8",
			timeout: 20_000,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
			// npm is a .cmd shim on Windows, which needs a shell to launch.
			shell: process.platform === "win32",
		}).trim();
	} catch {
		return undefined;
	}
}

/** Same shape pi's launcher accepts for `current-version`. */
const VERSION_PATTERN = /^[0-9A-Za-z._+-]+$/;

/**
 * The pi package inside a managed install rooted at `agentDir`, or undefined
 * when that directory holds no (valid) managed install.
 */
export function managedPiRoot(agentDir: string): string | undefined {
	try {
		const version = fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf-8").trim();
		if (!VERSION_PATTERN.test(version) || version === "." || version === "..") return undefined;
		const candidate = path.join(agentDir, "install", "releases", version, "node_modules", PACKAGE);
		return fs.existsSync(path.join(candidate, "package.json")) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Agent directories of the pi that is actually in use.
 *
 * `pi-launcher.js` is what typing `pi` runs, so its install is the one worth
 * testing against. Two signals point at it, neither of which the integration
 * harness disturbs (it redirects `PI_CODING_AGENT_DIR` to a throwaway directory,
 * which would otherwise hide the real install from every test that imports it):
 * `PI_MANAGED_INSTALL_ROOT`, which the launcher sets for the pi it spawns — so
 * it is present when the tests run from inside a pi session, whatever `PATH`
 * says — and a launcher sitting in a `bin/` directory on `PATH`.
 */
function launcherAgentDirs(): string[] {
	const dirs: string[] = [];
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
	if (installRoot) dirs.push(path.dirname(installRoot));
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		if (entry && fs.existsSync(path.join(entry, "pi-launcher.js"))) dirs.push(path.dirname(entry));
	}
	return dirs;
}

/** Agent directories to try when no launcher is on PATH: weaker evidence. */
function fallbackAgentDirs(): string[] {
	const dirs: string[] = [];
	if (process.env.PI_CODING_AGENT_DIR) dirs.push(process.env.PI_CODING_AGENT_DIR);
	dirs.push(path.join(os.homedir(), ".pi", "agent"));
	return dirs;
}

/** The first managed install among `agentDirs`. */
function firstManaged(agentDirs: string[]): string | undefined {
	for (const agentDir of agentDirs) {
		const managed = managedPiRoot(agentDir);
		if (managed) return managed;
	}
	return undefined;
}

/** The pi package under `<root>/@earendil-works`, if `root` has one. */
function piIn(root: string): string | undefined {
	const candidate = path.join(root, PACKAGE);
	return fs.existsSync(path.join(candidate, "package.json")) ? candidate : undefined;
}

/** The pi package under `npm root -g`; shells out, so it is the last resort. */
function piInNpmGlobal(): string | undefined {
	const globalRoot = npmGlobalRoot();
	return globalRoot ? piIn(globalRoot) : undefined;
}

/**
 * Root directory of the installed pi package, or undefined if not found.
 *
 * Order matters when several installs exist: an install inside the project is
 * explicit, then the managed install behind the `pi` launcher (what the
 * developer actually runs), then global npm layouts, then managed
 * installs found only by convention, then `npm root -g`. A stale global npm
 * copy therefore cannot shadow the install `pi` really uses.
 */
export function findPiRoot(): string | undefined {
	const nodeDir = path.dirname(process.execPath);
	return (
		piIn(path.join(process.cwd(), "node_modules")) ??
		firstManaged(launcherAgentDirs()) ??
		piIn(path.join(nodeDir, "node_modules")) ??
		piIn(path.join(nodeDir, "..", "lib", "node_modules")) ??
		firstManaged(fallbackAgentDirs()) ??
		// Cheap guesses missed — this is the custom-prefix case.
		piInNpmGlobal()
	);
}

/**
 * One of pi's dependencies, wherever the package manager put it: nested under
 * pi's own `node_modules`, or hoisted next to pi (managed installs and plain
 * `npm i` both hoist, since pi's dependencies are not in conflict).
 */
function dependencyPath(piRoot: string, ...segments: string[]): string | undefined {
	const containingModules = path.resolve(piRoot, "..", "..");
	for (const modules of [path.join(piRoot, "node_modules"), containingModules]) {
		const candidate = path.join(modules, ...segments);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Path to pi's bundled jiti entry point, or undefined. */
export function findJitiEntry(): string | undefined {
	const piRoot = findPiRoot();
	return piRoot && dependencyPath(piRoot, "jiti", "lib", "jiti.mjs");
}

/** Path to pi's bundled `@types/node`, for the typecheck script. */
export function findNodeTypes(): string | undefined {
	const piRoot = findPiRoot();
	const node = piRoot && dependencyPath(piRoot, "@types", "node");
	return node && path.dirname(node);
}
