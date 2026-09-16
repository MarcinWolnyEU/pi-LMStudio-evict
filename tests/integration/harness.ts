/**
 * Shared setup for the live integration tests.
 *
 * These tests run against a *real* LM Studio on the machine executing them.
 * Three rules shape everything here:
 *
 *   1. **No LM Studio, no pass.** A missing `lms`, a stopped server, or a
 *      catalogue with fewer than two chat models fails the run. Skipping
 *      would let a broken extension look tested.
 *   2. **Nothing is hardcoded.** Models are discovered from `lms ls` and the
 *      two smallest are chosen, so the suite runs on any machine. `lms` is
 *      taken from PATH; no install location is assumed.
 *   3. **No assumption about starting state.** Whatever LM Studio happens to
 *      have resident is unloaded before the sequence begins.
 *
 * The suite also redirects `PI_CODING_AGENT_DIR` at import time, so config,
 * claims, locks, and `models.json` all land in a throwaway directory and the
 * developer's own pi setup is never touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

/**
 * Redirect every path the extension writes to. Set before anything imports
 * the library modules — they read this variable on each call, and the test
 * files import this harness first.
 */
export const TEST_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lmstudio-evict-test-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;

import { type CatalogModel, listCatalog, listLoaded, serverStatus, unloadAll } from "../../extensions/lib/lms.ts";

/** Generous: a cold load of a multi-GB model over a slow disk takes minutes. */
export const LONG_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Timing report
// ---------------------------------------------------------------------------

export interface Timing {
	label: string;
	ms: number;
}

const timings: Timing[] = [];

/**
 * Run `fn`, record how long it took, and echo it as a test diagnostic so the
 * duration shows up in the reporter output rather than only in a summary.
 */
export async function timed<T>(t: TestContext, label: string, fn: () => Promise<T>): Promise<T> {
	const started = Date.now();
	try {
		return await fn();
	} finally {
		const ms = Date.now() - started;
		timings.push({ label, ms });
		t.diagnostic(`timing | ${label}: ${formatMs(ms)}`);
	}
}

export function recordTiming(t: TestContext, label: string, ms: number): void {
	timings.push({ label, ms });
	t.diagnostic(`timing | ${label}: ${formatMs(ms)}`);
}

export function formatMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

/** Print the collected timings as a table. Call from an `after()` hook. */
export function printTimingReport(title: string): void {
	if (timings.length === 0) return;
	const width = Math.max(...timings.map((entry) => entry.label.length), title.length);
	const total = timings.reduce((sum, entry) => sum + entry.ms, 0);
	const line = "-".repeat(width + 14);
	console.log(`\n${title}`);
	console.log(line);
	for (const entry of timings) {
		console.log(`${entry.label.padEnd(width)}  ${formatMs(entry.ms).padStart(10)}`);
	}
	console.log(line);
	console.log(`${"TOTAL".padEnd(width)}  ${formatMs(total).padStart(10)}`);
	console.log(`${"steps".padEnd(width)}  ${String(timings.length).padStart(10)}`);
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface Preflight {
	port?: number;
	catalog: CatalogModel[];
	/** Chat models sorted smallest first. */
	chat: CatalogModel[];
	/** The two smallest chat models — what the suite loads and unloads. */
	small: [CatalogModel, CatalogModel];
	/** Models LM Studio already had resident when the suite started. */
	preexisting: string[];
}

let cached: Preflight | undefined;

/**
 * Verify the environment and pick the test models. Throws — loudly, with the
 * reason — when LM Studio is not usable.
 */
export async function preflight(): Promise<Preflight> {
	if (cached) return cached;

	const status = await serverStatus();
	if (status === undefined) {
		throw new Error(
			"LM Studio is not reachable: `lms server status --json` failed. " +
				"Ensure the `lms` CLI is on PATH (it ships with LM Studio) and that LM Studio is installed. " +
				"These are live integration tests; they cannot run without it.",
		);
	}
	if (!status.running) {
		throw new Error(
			"The LM Studio local server is not running. Start it (LM Studio > Developer > Start Server, " +
				"or `lms server start`) and re-run the tests.",
		);
	}

	const catalog = await listCatalog();
	if (!catalog) {
		throw new Error("`lms ls --json` failed — cannot read the LM Studio model catalogue.");
	}

	const chat = catalog
		.filter((model) => model.type !== "embedding" && typeof model.modelKey === "string")
		.sort((a, b) => (a.sizeBytes ?? Number.MAX_SAFE_INTEGER) - (b.sizeBytes ?? Number.MAX_SAFE_INTEGER));

	if (chat.length < 2) {
		throw new Error(
			`These tests need at least two non-embedding models in LM Studio; found ${chat.length}. ` +
				"Download another model and re-run.",
		);
	}

	const loaded = await listLoaded();
	cached = {
		port: status.port,
		catalog,
		chat,
		small: [chat[0], chat[1]],
		preexisting: (loaded ?? []).map((model) => model.identifier),
	};
	return cached;
}

/**
 * Bring LM Studio to a known empty state. Called before the sequence starts
 * and again at the end, so a failed run does not leave models resident.
 */
export async function resetLmStudio(): Promise<string[]> {
	const before = (await listLoaded()) ?? [];
	if (before.length > 0) await unloadAll();
	return before.map((model) => model.identifier);
}

/** Identifiers currently resident, for assertions. */
export async function residentIdentifiers(): Promise<string[]> {
	const loaded = await listLoaded();
	if (!loaded) throw new Error("`lms ps --json` failed mid-test — LM Studio became unreachable.");
	return loaded.map((model) => model.identifier).sort();
}

/** Model keys currently resident, for assertions. */
export async function residentKeys(): Promise<string[]> {
	const loaded = await listLoaded();
	if (!loaded) throw new Error("`lms ps --json` failed mid-test — LM Studio became unreachable.");
	return loaded.map((model) => model.modelKey ?? model.identifier).sort();
}

/** Remove the throwaway agent directory. */
export function cleanupAgentDir(): void {
	try {
		fs.rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
	} catch {
		// Windows can hold a handle briefly; a leftover temp dir is harmless.
	}
}
