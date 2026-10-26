/**
 * Pure-function tests for the parts of `lms` output that are not JSON, and
 * for the eviction planner.
 *
 * These need no LM Studio: they pin down behaviour that is awkward to
 * provoke against a live instance (a model that fails the guardrails, a
 * duplicate `key:2` instance, a locale that groups digits with a
 * non-breaking space).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { contextLengthFor, extraArgsFor, loadArgs } from "../../extensions/lib/config.ts";
import { type LoadedModel, parseEstimate, parseSizeBytes } from "../../extensions/lib/lms.ts";
import { fitOf, formatBytes } from "../../extensions/lib/memory.ts";
import {
	bareModelKey,
	duplicateIdentifiers,
	hasWrongContext,
	isResident,
	isUsable,
	matchesModelKey,
	planEviction,
} from "../../extensions/lib/orchestrator.ts";

const GIB = 1024 ** 3;

test("parseSizeBytes: reads the binary units lms prints", () => {
	assert.equal(parseSizeBytes("512 B"), 512);
	assert.equal(parseSizeBytes("1 KiB"), 1024);
	assert.equal(parseSizeBytes("6.66 GiB"), 6.66 * GIB);
	assert.equal(parseSizeBytes("1 TiB"), 1024 ** 4);
});

test("parseSizeBytes: tolerates grouped digits and stray colour codes", () => {
	// lms groups thousands by locale: non-breaking, thin, or narrow no-break space.
	for (const sep of [0x00a0, 0x2009, 0x202f]) {
		const text = `1${String.fromCharCode(sep)}024 MiB`;
		assert.equal(parseSizeBytes(text), 1024 * 1024 ** 2, `separator U+${sep.toString(16)}`);
	}
	const esc = String.fromCharCode(0x1b);
	assert.equal(parseSizeBytes(`${esc}[32m6.66 GiB${esc}[39m`), 6.66 * GIB);
});

test("parseSizeBytes: returns undefined for anything that is not a size", () => {
	assert.equal(parseSizeBytes("LOW"), undefined);
	assert.equal(parseSizeBytes(""), undefined);
	assert.equal(parseSizeBytes("Confidence"), undefined);
});

test("parseEstimate: reads a full estimate block", () => {
	const stdout = [
		"Model: qwen3-coder-30b-a3b-instruct",
		"Context Length: 32 768",
		"Estimated GPU Memory:   17.35 GiB",
		"Estimated Total Memory: 18.00 GiB",
		"Confidence: LOW",
		"",
		"Estimate: This model may be loaded based on your resource guardrails settings.",
	].join("\n");

	const estimate = parseEstimate(stdout);

	assert.equal(estimate.vramBytes, 17.35 * GIB);
	assert.equal(estimate.totalBytes, 18 * GIB);
	assert.equal(estimate.confidence, "LOW");
	assert.equal(estimate.passesGuardrails, true);
});

test("parseEstimate: reads the negative guardrail verdict", () => {
	const estimate = parseEstimate(
		"Estimate: This model will fail to load based on your resource guardrails settings.",
	);
	assert.equal(estimate.passesGuardrails, false);
});

test("parseEstimate: a partial block yields a partial result rather than an error", () => {
	const estimate = parseEstimate("Model: something\nConfidence: HIGH\n");
	assert.deepEqual(estimate, { confidence: "HIGH" });
});

test("parseEstimate: survives CRLF and empty input", () => {
	assert.equal(parseEstimate("Estimated Total Memory: 1 GiB\r\n").totalBytes, GIB);
	assert.deepEqual(parseEstimate(""), {});
});

test("bareModelKey: strips a provider prefix, including multi-server ones", () => {
	assert.equal(bareModelKey("lmstudio", "lmstudio/gemma-3-12b"), "gemma-3-12b");
	assert.equal(
		bareModelKey("lmstudio/desktop", "lmstudio/desktop/qwen3-coder-30b"),
		"qwen3-coder-30b",
	);
	// Already bare, and a key that merely looks prefixed.
	assert.equal(bareModelKey("lmstudio", "gemma-3-12b"), "gemma-3-12b");
	assert.equal(bareModelKey("lmstudio", "google/gemma-4-12b-qat"), "google/gemma-4-12b-qat");
});

function loaded(identifier: string, modelKey?: string): LoadedModel {
	return { identifier, modelKey };
}

test("matchesModelKey: identifies a model by key, identifier, or :n suffix", () => {
	assert.equal(matchesModelKey(loaded("alpha", "alpha"), "alpha"), true);
	assert.equal(matchesModelKey(loaded("alpha"), "alpha"), true);
	// LM Studio names a second copy of the same model "alpha:2".
	assert.equal(matchesModelKey(loaded("alpha:2", "alpha"), "alpha"), true);
	assert.equal(matchesModelKey(loaded("alpha:2"), "alpha"), true);
	assert.equal(matchesModelKey(loaded("alphabet", "alphabet"), "alpha"), false);
	assert.equal(matchesModelKey(loaded("beta", "beta"), "alpha"), false);
});

test("isResident: reports whether the key is in memory at all", () => {
	assert.equal(isResident([loaded("beta", "beta")], "alpha"), false);
	assert.equal(isResident([loaded("beta", "beta"), loaded("alpha", "alpha")], "alpha"), true);
	assert.equal(isResident([], "alpha"), false);
});

test("planEviction: unloads everything except the target when nothing is claimed", () => {
	const plan = planEviction(
		[loaded("alpha", "alpha"), loaded("beta", "beta")],
		"alpha",
		new Set(),
	);

	assert.deepEqual(plan.victims.map((m) => m.identifier), ["beta"]);
	assert.deepEqual(plan.keep.map((m) => m.identifier), ["alpha"]);
	assert.equal(plan.targetResident, true);
});

test("planEviction: with nothing to keep, everything is a victim", () => {
	const plan = planEviction([loaded("beta", "beta")], "alpha", new Set());

	assert.deepEqual(plan.keep, [], "an empty keep set lets the caller use unload --all");
	assert.deepEqual(plan.victims.map((m) => m.identifier), ["beta"]);
	assert.equal(plan.targetResident, false);
});

test("planEviction: spares models another session has claimed", () => {
	const plan = planEviction(
		[loaded("alpha", "alpha"), loaded("beta", "beta"), loaded("gamma", "gamma")],
		"alpha",
		new Set(["beta"]),
	);

	assert.deepEqual(plan.keep.map((m) => m.identifier).sort(), ["alpha", "beta"]);
	assert.deepEqual(plan.victims.map((m) => m.identifier), ["gamma"]);
});

test("planEviction: surplus copies of the target are unloaded, one is kept", () => {
	// Loading an already-resident model gives LM Studio a second copy; the
	// duplicate is pure waste and must be reaped.
	const plan = planEviction(
		[loaded("alpha", "alpha"), loaded("alpha:2", "alpha"), loaded("alpha:3", "alpha")],
		"alpha",
		new Set(),
	);

	assert.deepEqual(plan.keep.map((m) => m.identifier), ["alpha"]);
	assert.deepEqual(plan.victims.map((m) => m.identifier), ["alpha:2", "alpha:3"]);
	assert.equal(plan.targetResident, true);
});

/** A resident copy loaded at `contextLength`, used once unless `used` is false. */
function sized(identifier: string, contextLength: number, used = true): LoadedModel {
	return { identifier, modelKey: identifier.replace(/:\d+$/, ""), contextLength, lastUsedTime: used ? 1 : null };
}

test("hasWrongContext: compares only when a context is wanted and known", () => {
	assert.equal(hasWrongContext(sized("alpha", 4096), undefined), false);
	assert.equal(hasWrongContext(loaded("alpha", "alpha"), 32768), false, "no contextLength reported");
	assert.equal(hasWrongContext(sized("alpha", 32768), 32768), false);
	assert.equal(hasWrongContext(sized("alpha", 4096), 32768), true);
	assert.equal(hasWrongContext(sized("alpha", 65536), 32768), true, "too big is wrong too: it costs memory");
});

test("hasWrongContext: the 8192 a loading model reports is not taken at face value", () => {
	// Mid-load, lms ps shows 8192 whatever the load asked for (AGENTS.md).
	// Treating that as wrong would unload every load in flight.
	assert.equal(hasWrongContext(sized("alpha", 8192, false), 32768), false);
	// Once the model has served a request it has finished loading, so 8192 is
	// real — the just-in-time-load-at-the-default case this exists to fix.
	assert.equal(hasWrongContext(sized("alpha", 8192, true), 32768), true);
});

test("isUsable: resident at the wanted context, or resident with nothing wanted", () => {
	assert.equal(isUsable([sized("alpha", 4096)], "alpha", undefined), true);
	assert.equal(isUsable([sized("alpha", 4096)], "alpha", 32768), false);
	assert.equal(isUsable([sized("alpha", 4096), sized("alpha:2", 32768)], "alpha", 32768), true);
	assert.equal(isUsable([sized("beta", 32768)], "alpha", 32768), false);
});

test("planEviction: a target copy at the wrong context is unloaded and reloaded", () => {
	const plan = planEviction([sized("alpha", 4096), sized("beta", 32768)], "alpha", new Set(), 32768);

	assert.deepEqual(plan.keep, []);
	assert.deepEqual(plan.victims.map((m) => m.identifier), ["alpha", "beta"]);
	assert.equal(plan.targetResident, false, "the caller must load it again");
});

test("planEviction: keeps the copy at the right context and reaps the rest", () => {
	const plan = planEviction([sized("alpha", 4096), sized("alpha:2", 32768)], "alpha", new Set(), 32768);

	assert.deepEqual(plan.keep.map((m) => m.identifier), ["alpha:2"]);
	assert.deepEqual(plan.victims.map((m) => m.identifier), ["alpha"]);
	assert.equal(plan.targetResident, true);
});

test("planEviction: a wrong-context copy another session claimed is left alone", () => {
	const plan = planEviction([sized("alpha", 4096)], "alpha", new Set(["alpha"]), 32768);

	assert.deepEqual(plan.keep.map((m) => m.identifier), ["alpha"]);
	assert.deepEqual(plan.victims, []);
	assert.equal(plan.targetResident, true, "and not loaded a second time beside it");
});

test("contextLengthFor: hand-written contextWindow, then the global setting, then nothing", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evict-ctx-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const modelsPath = path.join(dir, "models.json");
	fs.writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				lmstudio: {
					models: [
						{ id: "hand", contextWindow: 32768 },
						{ id: "managed", contextWindow: 262144, managedBy: "pi-lmstudio-evict" },
						{ id: "broken", contextWindow: "lots" },
					],
				},
				"lmstudio/desktop": { models: [{ id: "remote", contextWindow: 16384 }] },
				openai: { models: [{ id: "elsewhere", contextWindow: 999 }] },
			},
		}),
	);

	assert.equal(contextLengthFor("hand", {}, modelsPath), 32768);
	assert.equal(contextLengthFor("remote", {}, modelsPath), 16384, "any lmstudio* provider");
	// A generated entry carries the model's maximum; loading at that could
	// need more memory than the machine has.
	assert.equal(contextLengthFor("managed", {}, modelsPath), undefined);
	assert.equal(contextLengthFor("managed", { contextLength: 16384 }, modelsPath), 16384);
	assert.equal(contextLengthFor("broken", { contextLength: 8192 }, modelsPath), 8192);
	assert.equal(contextLengthFor("elsewhere", {}, modelsPath), undefined, "only LM Studio providers");
	assert.equal(contextLengthFor("hand", { contextLength: 4096 }, modelsPath), 32768, "per-model wins");
	assert.equal(contextLengthFor("hand", { matchContextWindow: false, contextLength: 4096 }, modelsPath), 4096);
	assert.equal(contextLengthFor("hand", { contextLength: 0 }, path.join(dir, "missing.json")), undefined);
});

test("loadArgs: always scripts non-interactively, and only sets a TTL when configured", () => {
	assert.deepEqual(loadArgs("alpha", {}), ["load", "alpha", "--yes"]);
	assert.deepEqual(loadArgs("alpha", { ttlSeconds: 900 }), ["load", "alpha", "--yes", "--ttl", "900"]);
	// Nonsense TTLs must not reach the CLI.
	assert.deepEqual(loadArgs("alpha", { ttlSeconds: 0 }), ["load", "alpha", "--yes"]);
	assert.deepEqual(loadArgs("alpha", { ttlSeconds: -5 }), ["load", "alpha", "--yes"]);
	assert.deepEqual(loadArgs("alpha", { ttlSeconds: 12.7 }), ["load", "alpha", "--yes", "--ttl", "12"]);
});

test("loadArgs: passes a context length only when it is a positive number", () => {
	assert.deepEqual(loadArgs("alpha", {}, 32768), ["load", "alpha", "--yes", "--context-length", "32768"]);
	assert.deepEqual(loadArgs("alpha", { ttlSeconds: 900 }, 32768), [
		"load",
		"alpha",
		"--yes",
		"--ttl",
		"900",
		"--context-length",
		"32768",
	]);
	assert.deepEqual(loadArgs("alpha", {}, undefined), ["load", "alpha", "--yes"]);
	assert.deepEqual(loadArgs("alpha", {}, 0), ["load", "alpha", "--yes"]);
	assert.deepEqual(loadArgs("alpha", {}, Number.NaN), ["load", "alpha", "--yes"]);
});

test("fitOf: grades a model against free RAM and VRAM", () => {
	const ramFree = 8 * GIB;
	const vramFree = 6 * GIB;

	assert.equal(fitOf(4 * GIB, ramFree, vramFree), "fits");
	// Bigger than VRAM alone: it can only load by spilling into RAM.
	assert.equal(fitOf(7 * GIB, ramFree, vramFree), "tight");
	// Bigger than both pools combined.
	assert.equal(fitOf(20 * GIB, ramFree, vramFree), "over");
	// Without a GPU the comparison degrades to RAM only.
	assert.equal(fitOf(7 * GIB, ramFree), "fits");
	assert.equal(fitOf(9 * GIB, ramFree), "over");
	// An unknown size cannot be flagged.
	assert.equal(fitOf(undefined, ramFree, vramFree), "fits");
});

test("formatBytes: binary units, matching how lms reports memory", () => {
	assert.equal(formatBytes(6.66 * GIB), "6.7 GiB");
	assert.equal(formatBytes(512 * 1024 ** 2), "512 MiB");
	assert.equal(formatBytes(undefined), "size?");
	assert.equal(formatBytes(Number.NaN), "size?");
});

test("duplicateIdentifiers flags only the surplus copies of a model", () => {
	const none = duplicateIdentifiers([loaded("alpha", "alpha"), loaded("beta", "beta")]);
	assert.equal(none.size, 0);

	const twice = duplicateIdentifiers([loaded("alpha", "alpha"), loaded("alpha:2", "alpha"), loaded("beta", "beta")]);
	assert.deepEqual([...twice], ["alpha:2"]);

	// A custom --identifier is still a copy of the same modelKey.
	const custom = duplicateIdentifiers([loaded("alpha", "alpha"), loaded("mine", "alpha"), loaded("alpha:3", "alpha")]);
	assert.deepEqual([...custom], ["mine", "alpha:3"]);

	// "Extra" is about list order, the same copy planEviction would keep for the target.
	assert.deepEqual([...duplicateIdentifiers([loaded("alpha:2", "alpha"), loaded("alpha", "alpha")])], ["alpha"]);

	// Entries without a modelKey fall back to the identifier minus its `:n` suffix.
	assert.deepEqual([...duplicateIdentifiers([loaded("alpha"), loaded("alpha:2")])], ["alpha:2"]);
});

test("extraArgsFor: global flags, then the model's own", () => {
	const config = {
		extraLoadArgs: ["--gpu", "max"],
		modelLoadArgs: { alpha: ["--speculative-draft-mtp"], beta: ["--parallel", "2"] },
	};
	assert.deepEqual(extraArgsFor("alpha", config), ["--gpu", "max", "--speculative-draft-mtp"]);
	assert.deepEqual(extraArgsFor("gamma", config), ["--gpu", "max"]);
	assert.deepEqual(extraArgsFor("alpha", {}), []);
});

test("extraArgsFor: drops flags the extension owns, with their values", () => {
	const config = {
		extraLoadArgs: [
			"--gpu", "0.5",
			"--context-length", "4096",
			"-c", "4096",
			"--ttl=60",
			"--identifier", "mine",
			"--estimate-only",
			"-y",
			"--parallel", "4",
		],
	};
	assert.deepEqual(extraArgsFor("alpha", config), ["--gpu", "0.5", "--parallel", "4"]);
});

test("extraArgsFor: tolerates hand-edited junk", () => {
	const config = { extraLoadArgs: "--gpu max", modelLoadArgs: { alpha: [42, "", "--parallel", "2"] } } as never;
	assert.deepEqual(extraArgsFor("alpha", config), ["--parallel", "2"]);
});

test("loadArgs: extra flags go last, after the ones the extension sets", () => {
	assert.deepEqual(loadArgs("alpha", { ttlSeconds: 900, extraLoadArgs: ["--gpu", "max"] }, 32768), [
		"load",
		"alpha",
		"--yes",
		"--ttl",
		"900",
		"--context-length",
		"32768",
		"--gpu",
		"max",
	]);
});
