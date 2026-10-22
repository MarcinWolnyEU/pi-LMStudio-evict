/**
 * Typecheck without committing anyone's install paths.
 *
 * The awkwardness is structural: this package has no `node_modules`, and pi
 * is a peer dependency usually installed globally. So `@types/node` and pi's
 * own type declarations live at a path that differs per machine, and a
 * `tsconfig.json` with `typeRoots`/`paths` baked in only ever works on the
 * machine it was written on (it previously hardcoded `C:/nvm4w/...`).
 *
 * This script discovers both at run time, writes a generated tsconfig that
 * extends the committed one, and runs `tsc` against it.
 *
 *     node tests/typecheck.mjs
 *
 * Lives in `tests/` rather than a `scripts/` directory because a typecheck is
 * a test: it is the only check that reads the `.ts` sources as types rather
 * than executing them, and `npm run typecheck` sits beside `npm test` in the
 * same workflow. `repoRoot` below is one level up either way, so the move
 * cost nothing.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// An absolute Windows path is not a valid ESM specifier; it must be a URL.
const { findPiRoot, findNodeTypes } = await import(
	pathToFileURL(path.join(repoRoot, "tests", "support", "find-pi.ts")).href
);

const piRoot = findPiRoot();
const nodeTypes = findNodeTypes();

if (!piRoot || !nodeTypes) {
	console.error(
		"Cannot typecheck: the pi package (and its bundled @types/node) was not found.\n" +
			"Install it with:  npm i -g @earendil-works/pi-coding-agent\n" +
			"or add it to this project:  npm i --no-save @earendil-works/pi-coding-agent\n" +
			`(searched ./node_modules, a pi-launcher.js directory on PATH, ~/.pi/agent/install, ` +
			`node at ${process.execPath}, and \`npm root -g\`)`,
	);
	process.exit(1);
}

const generated = {
	extends: path.join(repoRoot, "tsconfig.json").replaceAll("\\", "/"),
	compilerOptions: {
		typeRoots: [nodeTypes.replaceAll("\\", "/")],
		types: ["node"],
		paths: {
			"@earendil-works/pi-coding-agent": [
				path.join(piRoot, "dist", "index.d.ts").replaceAll("\\", "/"),
			],
		},
	},
	include: [
		path.join(repoRoot, "extensions", "**", "*.ts").replaceAll("\\", "/"),
		path.join(repoRoot, "tests", "**", "*.ts").replaceAll("\\", "/"),
		path.join(repoRoot, "tests", "**", "*.mjs").replaceAll("\\", "/"),
	],
};

const configPath = path.join(os.tmpdir(), `pi-lmstudio-evict-tsconfig-${process.pid}.json`);
fs.writeFileSync(configPath, JSON.stringify(generated, null, 2), "utf-8");

/** `tsc` from a local install, then from PATH. */
function tscCommand() {
	const local = path.join(
		repoRoot,
		"node_modules",
		".bin",
		process.platform === "win32" ? "tsc.cmd" : "tsc",
	);
	if (fs.existsSync(local)) return { command: local, shell: process.platform === "win32" };
	return { command: "tsc", shell: process.platform === "win32" };
}

try {
	const { command, shell } = tscCommand();
	console.log(`pi:        ${piRoot}`);
	console.log(`@types:    ${nodeTypes}`);
	const result = spawnSync(command, ["-p", configPath], { stdio: "inherit", shell });
	if (result.error) {
		console.error(
			`Cannot run \`tsc\`: ${result.error.message}\n` +
				"Install TypeScript globally (npm i -g typescript) or locally (npm i --no-save typescript).",
		);
		process.exit(1);
	}
	if (result.status === 0) console.log("typecheck: clean");
	process.exit(result.status ?? 1);
} finally {
	fs.rmSync(configPath, { force: true });
}
