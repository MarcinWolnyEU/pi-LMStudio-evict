/**
 * Auto-registration of LM Studio models into pi's `models.json`.
 *
 * The ownership policy is tested against synthetic catalogues, because the
 * cases that matter (a model disappearing, a hand-written entry colliding
 * with a generated one) cannot be produced by deleting the developer's real
 * models. The final tests use the *live* catalogue to prove the same code
 * produces a real, valid file for whatever LM Studio actually holds.
 *
 * Every write goes to the throwaway agent directory from harness.ts, so the
 * developer's own models.json is never touched.
 */

import { cleanupAgentDir, preflight, printTimingReport, timed } from "./harness.ts";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { findPiRoot } from "../support/find-pi.ts";
import { agentDir, modelsJsonPath } from "../../extensions/lib/config.ts";
import type { CatalogModel } from "../../extensions/lib/lms.ts";
import {
	MANAGED_BY,
	type ModelEntry,
	type ModelsJson,
	describeSync,
	isManaged,
	planSync,
	syncModelsJson,
	toModelEntry,
} from "../../extensions/lib/registry.ts";

function catalogEntry(modelKey: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
	return {
		modelKey,
		type: "llm",
		displayName: modelKey,
		sizeBytes: 1_000_000,
		maxContextLength: 32_768,
		...overrides,
	};
}

/** A models.json path of its own, so tests cannot bleed into each other. */
function scratchModelsPath(name: string): string {
	const file = path.join(agentDir(), "scratch", `${name}.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.rmSync(file, { force: true });
	fs.rmSync(`${file}.bak-pi-lmstudio-evict`, { force: true });
	return file;
}

function read(file: string): ModelsJson {
	return JSON.parse(fs.readFileSync(file, "utf-8")) as ModelsJson;
}

interface PiModelConfigModule {
	ModelConfig: { load(path: string): Promise<{ error?: string }> };
}

/**
 * Reach pi's internal models.json validator.
 *
 * Deliberately awkward: the module lives behind the package's exports map,
 * so the bare specifier only works when pi is a local dependency. Otherwise
 * `findPiRoot()` handles the global-install layouts, including a custom npm
 * prefix. Resolves to undefined when pi genuinely is not installed, and the
 * caller then degrades.
 */
async function importPiModelConfig(): Promise<PiModelConfigModule | undefined> {
	const piRoot = findPiRoot();
	const candidates = ["@earendil-works/pi-coding-agent/dist/core/model-config.js"];
	if (piRoot) {
		candidates.push(
			pathToFileURL(path.join(piRoot, "dist", "core", "model-config.js")).href,
		);
	}
	for (const specifier of candidates) {
		const module = await import(specifier).catch(() => undefined);
		if (module?.ModelConfig) return module as PiModelConfigModule;
	}
	return undefined;
}

function lmstudioModels(file: string): ModelEntry[] {
	return read(file).providers.lmstudio?.models ?? [];
}

after(() => {
	printTimingReport("models.json timings");
	cleanupAgentDir();
});

// ---------------------------------------------------------------------------
// The ownership policy, in isolation
// ---------------------------------------------------------------------------

test("planSync: registers models that are not in models.json yet", () => {
	const plan = planSync([], [catalogEntry("alpha"), catalogEntry("beta")]);

	assert.deepEqual(plan.added, ["alpha", "beta"]);
	assert.deepEqual(plan.removed, []);
	assert.equal(plan.models.length, 2);
	assert.ok(plan.models.every(isManaged), "generated entries must carry the ownership marker");
});

test("planSync: unregisters managed models that LM Studio no longer has", () => {
	const existing = [toModelEntry(catalogEntry("alpha")), toModelEntry(catalogEntry("gone"))];

	const plan = planSync(existing, [catalogEntry("alpha")]);

	assert.deepEqual(plan.removed, ["gone"], "a deleted model should be unregistered");
	assert.deepEqual(plan.models.map((m) => m.id), ["alpha"]);
});

test("planSync: never touches or removes a hand-written entry", () => {
	const handWritten: ModelEntry = {
		id: "mine",
		name: "My careful config",
		contextWindow: 262_144,
		maxTokens: 16_384,
	};

	// "mine" is not in the catalogue at all, and "alpha" is.
	const plan = planSync([handWritten], [catalogEntry("alpha")]);

	assert.deepEqual(plan.removed, [], "an unmanaged entry must never be removed");
	assert.deepEqual(plan.untouched, ["mine"]);
	assert.deepEqual(
		plan.models.find((m) => m.id === "mine"),
		handWritten,
		"the hand-written entry must survive byte-for-byte",
	);
	assert.deepEqual(plan.added, ["alpha"]);
});

test("planSync: a hand-written entry shadows the generated one for the same id", () => {
	const handWritten: ModelEntry = { id: "alpha", name: "Mine, not yours" };

	const plan = planSync([handWritten], [catalogEntry("alpha")]);

	assert.deepEqual(plan.added, [], "we must not add a duplicate for an id the user owns");
	assert.deepEqual(plan.untouched, ["alpha"]);
	assert.equal(plan.models.length, 1);
	assert.equal(plan.models[0].name, "Mine, not yours");
});

test("planSync: refreshes a managed entry when LM Studio's metadata changes", () => {
	const stale = toModelEntry(catalogEntry("alpha", { maxContextLength: 4_096, vision: false }));

	const plan = planSync([stale], [catalogEntry("alpha", { maxContextLength: 131_072, vision: true })]);

	assert.deepEqual(plan.updated, ["alpha"]);
	const entry = plan.models[0];
	assert.equal(entry.contextWindow, 131_072);
	assert.deepEqual(entry.input, ["text", "image"], "a model that gained vision should say so");
});

test("planSync: an unchanged managed entry is not reported as updated", () => {
	const model = catalogEntry("alpha");
	const plan = planSync([toModelEntry(model)], [model]);

	assert.deepEqual(plan.updated, []);
	assert.deepEqual(plan.added, []);
	assert.deepEqual(plan.removed, []);
});

test("planSync: embedding models are never registered", () => {
	const plan = planSync([], [catalogEntry("chatty"), catalogEntry("embedder", { type: "embedding" })]);

	assert.deepEqual(plan.added, ["chatty"], "pi cannot chat with an embedding model");
});

test("toModelEntry: maps LM Studio metadata onto pi's model shape", () => {
	const entry = toModelEntry(
		catalogEntry("vision-model", { vision: true, maxContextLength: 8_192, displayName: "Vision" }),
	);

	assert.equal(entry.id, "vision-model");
	assert.equal(entry.name, "Vision");
	assert.deepEqual(entry.input, ["text", "image"]);
	assert.equal(entry.contextWindow, 8_192);
	assert.equal(entry.maxTokens, 8_192, "maxTokens must not exceed the context window");
	assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(entry.managedBy, MANAGED_BY);
});

// ---------------------------------------------------------------------------
// Writing the file
// ---------------------------------------------------------------------------

test("syncModelsJson: creates the provider block and the file when absent", () => {
	const file = scratchModelsPath("fresh");

	const result = syncModelsJson({
		modelsPath: file,
		catalog: [catalogEntry("alpha"), catalogEntry("beta")],
		baseUrl: "http://localhost:4321/v1",
	});

	assert.equal(result.error, undefined);
	assert.equal(result.changed, true);
	const provider = read(file).providers.lmstudio;
	assert.equal(provider.baseUrl, "http://localhost:4321/v1", "the discovered port should be used");
	assert.equal(provider.api, "openai-completions");
	assert.deepEqual(provider.models?.map((m) => m.id), ["alpha", "beta"]);
});

test("syncModelsJson: a second run with the same catalogue changes nothing", () => {
	const file = scratchModelsPath("idempotent");
	const catalog = [catalogEntry("alpha")];

	syncModelsJson({ modelsPath: file, catalog });
	const first = fs.readFileSync(file, "utf-8");
	const result = syncModelsJson({ modelsPath: file, catalog });

	assert.equal(result.changed, false, "an in-sync file must not be rewritten");
	assert.equal(fs.readFileSync(file, "utf-8"), first);
	assert.equal(describeSync(result), "models.json already in sync");
});

test("syncModelsJson: unregisters a model that disappeared from LM Studio", () => {
	const file = scratchModelsPath("removal");
	syncModelsJson({ modelsPath: file, catalog: [catalogEntry("alpha"), catalogEntry("doomed")] });
	assert.deepEqual(lmstudioModels(file).map((m) => m.id), ["alpha", "doomed"]);

	const result = syncModelsJson({ modelsPath: file, catalog: [catalogEntry("alpha")] });

	assert.deepEqual(result.removed, ["doomed"]);
	assert.deepEqual(lmstudioModels(file).map((m) => m.id), ["alpha"]);
});

test("syncModelsJson: preserves other providers and hand-written entries", () => {
	const file = scratchModelsPath("preserve");
	fs.writeFileSync(
		file,
		JSON.stringify(
			{
				providers: {
					openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "some/model" }] },
					lmstudio: {
						baseUrl: "http://localhost:1234/v1",
						api: "openai-completions",
						models: [{ id: "hand-written", name: "Do not touch", contextWindow: 999 }],
					},
				},
			},
			null,
			2,
		),
	);

	const result = syncModelsJson({ modelsPath: file, catalog: [catalogEntry("alpha")] });

	assert.equal(result.error, undefined);
	const config = read(file);
	assert.deepEqual(
		config.providers.openrouter.models?.map((m) => m.id),
		["some/model"],
		"another provider must be left alone",
	);
	const handWritten = config.providers.lmstudio.models?.find((m) => m.id === "hand-written");
	assert.deepEqual(handWritten, { id: "hand-written", name: "Do not touch", contextWindow: 999 });
	assert.ok(config.providers.lmstudio.models?.some((m) => m.id === "alpha"));
});

test("syncModelsJson: leaves a one-time backup before the first change", () => {
	const file = scratchModelsPath("backup");
	const original = JSON.stringify({ providers: { lmstudio: { models: [] } } }, null, 2);
	fs.writeFileSync(file, original);

	syncModelsJson({ modelsPath: file, catalog: [catalogEntry("alpha")] });
	const backup = `${file}.bak-pi-lmstudio-evict`;
	assert.equal(fs.readFileSync(backup, "utf-8"), original, "the backup should hold the pre-sync file");

	syncModelsJson({ modelsPath: file, catalog: [catalogEntry("alpha"), catalogEntry("beta")] });
	assert.equal(
		fs.readFileSync(backup, "utf-8"),
		original,
		"the backup is a one-time snapshot, not a rolling copy",
	);
});

test("syncModelsJson: refuses to overwrite a models.json it cannot parse", () => {
	const file = scratchModelsPath("malformed");
	const broken = "{ this is not json";
	fs.writeFileSync(file, broken);

	const result = syncModelsJson({ modelsPath: file, catalog: [catalogEntry("alpha")] });

	assert.equal(result.changed, false);
	assert.match(result.error ?? "", /not valid JSON/);
	assert.equal(fs.readFileSync(file, "utf-8"), broken, "a file we cannot read must not be clobbered");
});

// ---------------------------------------------------------------------------
// Against the live catalogue
// ---------------------------------------------------------------------------

test("syncModelsJson: registers the machine's real LM Studio catalogue", { timeout: 120_000 }, async (t) => {
	const env = await preflight();
	const file = scratchModelsPath("live");

	const result = await timed(t, "sync live catalogue", async () =>
		syncModelsJson({
			modelsPath: file,
			catalog: env.catalog,
			baseUrl: `http://localhost:${env.port ?? 1234}/v1`,
		}),
	);

	assert.equal(result.error, undefined);
	t.diagnostic(`${describeSync(result)} — added: ${result.added.join(", ")}`);

	const registered = lmstudioModels(file).map((m) => m.id).sort();
	const expected = env.chat.map((m) => m.modelKey).sort();
	assert.deepEqual(registered, expected, "every chat model should be registered, and only those");

	for (const entry of lmstudioModels(file)) {
		assert.equal(entry.managedBy, MANAGED_BY);
		assert.ok((entry.contextWindow ?? 0) > 0, `${entry.id} should carry a context window`);
		assert.ok((entry.maxTokens ?? 0) > 0, `${entry.id} should carry maxTokens`);
	}
});

test("syncModelsJson: the file it writes passes pi's own schema validation", { timeout: 120_000 }, async (t) => {
	const env = await preflight();
	const file = scratchModelsPath("validated");
	syncModelsJson({ modelsPath: file, catalog: env.catalog });

	// Import pi's real validator rather than trusting our own reading of the
	// schema: this is what decides whether the user's pi starts up clean.
	const piModelConfig = await importPiModelConfig();

	if (!piModelConfig) {
		t.diagnostic("pi is not installed here; falling back to a JSON parse check");
		assert.doesNotThrow(() => read(file));
		return;
	}

	const config = await piModelConfig.ModelConfig.load(file);
	assert.equal(config.error, undefined, `pi rejected the generated models.json: ${config.error}`);
	t.diagnostic("pi's ModelConfig.load accepted the generated file");
});

test("the real models.json was never touched by this suite", async () => {
	// modelsJsonPath() resolves under the throwaway PI_CODING_AGENT_DIR, which
	// is the whole point: if this ever pointed at the user's home directory the
	// suite would be rewriting their model catalogue.
	assert.ok(
		modelsJsonPath().startsWith(agentDir()),
		"models.json must resolve inside the test agent dir",
	);
	assert.equal(
		fs.existsSync(modelsJsonPath()),
		false,
		"no test should have written the agent dir's top-level models.json",
	);
});
