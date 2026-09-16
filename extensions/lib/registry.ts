/**
 * Keeps pi's `models.json` in step with what LM Studio actually has on disk:
 * models you download show up in `/model` without hand-editing JSON, and
 * models you delete stop haunting the picker.
 *
 * The safety rule that makes this tolerable to run automatically: **an entry
 * is only ever added, rewritten, or removed if this extension created it.**
 * Ownership is recorded as `"managedBy": "pi-lmstudio-evict"` on the entry
 * (pi's models.json schema permits extra keys, verified against 0.85.x).
 * A hand-written entry is left exactly as it is — and its id counts as
 * taken, so we never shadow it with a generated duplicate. Delete the
 * `managedBy` key to adopt an entry; add it to hand ownership back.
 *
 * Writes go through a temp file and a rename, and the first modification
 * leaves a one-time `models.json.bak-pi-lmstudio-evict` behind.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogModel } from "./lms.ts";

/** Marker identifying entries this extension owns. */
export const MANAGED_BY = "pi-lmstudio-evict";

/** Provider block pi uses for LM Studio unless one already exists. */
export const DEFAULT_PROVIDER_ID = "lmstudio";

/** pi caps generated `maxTokens` here; long-context models rarely need more. */
const MAX_OUTPUT_TOKENS = 16_384;
/** Used when LM Studio reports no context length for a model. */
const FALLBACK_CONTEXT = 8_192;

export interface ModelEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	managedBy?: string;
	[key: string]: unknown;
}

export interface ProviderBlock {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: ModelEntry[];
	[key: string]: unknown;
}

export interface ModelsJson {
	providers: Record<string, ProviderBlock>;
	[key: string]: unknown;
}

export interface SyncPlan {
	/** Entries to write, in final order. */
	models: ModelEntry[];
	added: string[];
	updated: string[];
	removed: string[];
	/** Ids left alone because a hand-written entry owns them. */
	untouched: string[];
}

export interface SyncResult extends Omit<SyncPlan, "models"> {
	/** False when nothing needed writing. */
	changed: boolean;
	/** Set when the sync could not run; the file is then left untouched. */
	error?: string;
}

export function isManaged(entry: ModelEntry): boolean {
	return entry?.managedBy === MANAGED_BY;
}

/** Chat-capable models only — embeddings are not selectable in pi. */
export function chatModels(catalog: CatalogModel[]): CatalogModel[] {
	return catalog.filter((m) => m.type !== "embedding" && typeof m.modelKey === "string");
}

/** Translate one LM Studio catalogue entry into a pi model definition. */
export function toModelEntry(model: CatalogModel): ModelEntry {
	const contextWindow = model.maxContextLength ?? FALLBACK_CONTEXT;
	return {
		id: model.modelKey,
		name: model.displayName || model.modelKey,
		reasoning: false,
		input: model.vision ? ["text", "image"] : ["text"],
		contextWindow,
		maxTokens: Math.min(MAX_OUTPUT_TOKENS, contextWindow),
		// Local inference is free; pi still wants the shape to be present.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		managedBy: MANAGED_BY,
	};
}

/**
 * Work out the new model list without touching disk — the whole ownership
 * policy lives here, which is what makes it testable.
 */
export function planSync(existing: ModelEntry[], catalog: CatalogModel[]): SyncPlan {
	const wanted = new Map(chatModels(catalog).map((m) => [m.modelKey, m]));
	const models: ModelEntry[] = [];
	const added: string[] = [];
	const updated: string[] = [];
	const removed: string[] = [];
	const untouched: string[] = [];
	const seen = new Set<string>();

	for (const entry of existing) {
		const id = entry?.id;
		if (typeof id !== "string") {
			models.push(entry); // Not ours to judge; pass it through.
			continue;
		}
		seen.add(id);

		if (!isManaged(entry)) {
			models.push(entry);
			untouched.push(id);
			continue;
		}

		const model = wanted.get(id);
		if (!model) {
			// We added it, LM Studio no longer has it: unregister.
			removed.push(id);
			continue;
		}

		// Refresh the fields we generate, preserving anything else on the entry.
		const refreshed = { ...entry, ...toModelEntry(model) };
		if (JSON.stringify(refreshed) !== JSON.stringify(entry)) updated.push(id);
		models.push(refreshed);
	}

	for (const [id, model] of wanted) {
		if (seen.has(id)) continue;
		models.push(toModelEntry(model));
		added.push(id);
	}

	return { models, added, updated, removed, untouched };
}

function emptyResult(error?: string): SyncResult {
	return { changed: false, added: [], updated: [], removed: [], untouched: [], error };
}

/** Provider block created when `models.json` has no LM Studio provider yet. */
export function defaultProviderBlock(baseUrl: string): ProviderBlock {
	return {
		baseUrl,
		api: "openai-completions",
		// LM Studio ignores the key, but pi requires the provider to have one.
		apiKey: "lmstudio",
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
		models: [],
	};
}

export interface SyncOptions {
	modelsPath: string;
	catalog: CatalogModel[];
	/** Provider key in `models.json`. Defaults to "lmstudio". */
	providerId?: string;
	/** Used only when the provider block has to be created. */
	baseUrl?: string;
	/** Skip the one-time backup (tests, mostly). */
	backup?: boolean;
}

/**
 * Reconcile `models.json` against the LM Studio catalogue.
 *
 * Refuses to write when the file exists but does not parse: a malformed
 * config is the user's to fix, and clobbering it would lose their models.
 */
export function syncModelsJson(options: SyncOptions): SyncResult {
	const { modelsPath, catalog } = options;
	const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
	const baseUrl = options.baseUrl ?? "http://localhost:1234/v1";

	let raw: string | undefined;
	try {
		raw = fs.readFileSync(modelsPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return emptyResult(`Cannot read ${modelsPath}: ${(error as Error).message}`);
		}
	}

	let config: ModelsJson;
	if (raw === undefined || raw.trim() === "") {
		config = { providers: {} };
	} else {
		try {
			const parsed = JSON.parse(raw) as ModelsJson;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return emptyResult(`${modelsPath} is not a models.json object`);
			}
			config = parsed;
		} catch (error) {
			// Never overwrite a file we failed to understand.
			return emptyResult(`${modelsPath} is not valid JSON: ${(error as Error).message}`);
		}
	}

	if (!config.providers || typeof config.providers !== "object") config.providers = {};
	const provider = config.providers[providerId] ?? defaultProviderBlock(baseUrl);
	const existing = Array.isArray(provider.models) ? provider.models : [];

	const plan = planSync(existing, catalog);
	const changed =
		plan.added.length > 0 ||
		plan.removed.length > 0 ||
		plan.updated.length > 0 ||
		config.providers[providerId] === undefined;

	if (!changed) {
		return {
			changed: false,
			added: plan.added,
			updated: plan.updated,
			removed: plan.removed,
			untouched: plan.untouched,
		};
	}

	provider.models = plan.models;
	config.providers[providerId] = provider;

	try {
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		if (options.backup !== false && raw !== undefined) {
			const backupPath = `${modelsPath}.bak-pi-lmstudio-evict`;
			// One-time: the point is a pre-extension snapshot, not a rolling copy.
			if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, raw, "utf-8");
		}
		// Same directory so the rename stays on one filesystem, and atomic so a
		// crash mid-write cannot leave pi with a truncated catalogue.
		const tmpPath = `${modelsPath}.tmp-${process.pid}`;
		fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		fs.renameSync(tmpPath, modelsPath);
	} catch (error) {
		return emptyResult(`Cannot write ${modelsPath}: ${(error as Error).message}`);
	}

	return {
		changed: true,
		added: plan.added,
		updated: plan.updated,
		removed: plan.removed,
		untouched: plan.untouched,
	};
}

/** One-line summary for a toast or a log line. */
export function describeSync(result: SyncResult): string {
	if (result.error) return result.error;
	if (!result.changed) return "models.json already in sync";
	const parts: string[] = [];
	if (result.added.length) parts.push(`+${result.added.length}`);
	if (result.removed.length) parts.push(`-${result.removed.length}`);
	if (result.updated.length) parts.push(`~${result.updated.length}`);
	return `models.json updated (${parts.join(" ")})`;
}
