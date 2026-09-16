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

/** Root directory of the installed pi package, or undefined if not found. */
export function findPiRoot(): string | undefined {
	const nodeDir = path.dirname(process.execPath);
	const roots = [
		path.join(process.cwd(), "node_modules"),
		path.join(nodeDir, "node_modules"),
		path.join(nodeDir, "..", "lib", "node_modules"),
	];

	for (const root of roots) {
		const candidate = path.join(root, PACKAGE);
		if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
	}

	// Cheap guesses missed — this is the custom-prefix case.
	const globalRoot = npmGlobalRoot();
	if (globalRoot) {
		const candidate = path.join(globalRoot, PACKAGE);
		if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
	}
	return undefined;
}

/** Path to pi's bundled jiti entry point, or undefined. */
export function findJitiEntry(): string | undefined {
	const piRoot = findPiRoot();
	if (!piRoot) return undefined;
	const entry = path.join(piRoot, "node_modules", "jiti", "lib", "jiti.mjs");
	return fs.existsSync(entry) ? entry : undefined;
}

/** Path to pi's bundled `@types/node`, for the typecheck script. */
export function findNodeTypes(): string | undefined {
	const piRoot = findPiRoot();
	if (!piRoot) return undefined;
	const types = path.join(piRoot, "node_modules", "@types");
	return fs.existsSync(path.join(types, "node")) ? types : undefined;
}
