/**
 * Proves pi can actually load the extension.
 *
 * pi loads `.ts` extensions through jiti, not through Node's own type
 * stripping, and `extensions/evict.ts` imports six sibling modules with
 * explicit `.ts` specifiers. If jiti ever stops resolving those, the
 * extension fails silently at startup — pi keeps working and nothing evicts
 * anything. Every other test in this suite imports `lib/` directly and would
 * stay green through that, so this file is the one that would catch it.
 *
 * Degrades to a skip-with-diagnostic when pi is not installed, since it is a
 * peer dependency and a bare checkout may not have it.
 */

import { cleanupAgentDir } from "./harness.ts";

import assert from "node:assert/strict";
import * as path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { findJitiEntry } from "../support/find-pi.ts";

after(() => cleanupAgentDir());

test("pi's jiti loader can import the extension and register its hooks", { timeout: 120_000 }, async (t) => {
	const jitiEntry = findJitiEntry();

	if (!jitiEntry) {
		t.diagnostic("pi (or its bundled jiti) is not installed here; cannot exercise the real loader");
		t.skip("pi not installed");
		return;
	}
	t.diagnostic(`using pi's jiti at ${jitiEntry}`);

	const { createJiti } = await import(pathToFileURL(jitiEntry).href);
	const jiti = createJiti(import.meta.url, { interopDefault: true });

	const entry = path.resolve(import.meta.dirname, "../../extensions/evict.ts");
	const module = await jiti.import(entry);
	const factory = (module.default ?? module) as (api: unknown) => void;

	assert.equal(typeof factory, "function", "the extension must default-export a factory");

	// Drive the factory with a stub ExtensionAPI, the way pi's runtime does.
	const hooks: string[] = [];
	const commands: string[] = [];
	factory({
		on: (name: string) => hooks.push(name),
		registerCommand: (name: string, definition: { description?: string }) => {
			commands.push(name);
			assert.ok(definition.description, `${name} should carry a description for /help`);
		},
	});

	t.diagnostic(`hooks: ${hooks.join(", ")}`);
	t.diagnostic(`commands: ${commands.join(", ")}`);

	for (const hook of ["session_start", "session_shutdown", "model_select", "before_agent_start"]) {
		assert.ok(hooks.includes(hook), `the extension should subscribe to ${hook}`);
	}
	// The palette matches on command names only, and "model" is not a
	// subsequence of "lmstudio-evict" — without the suffix the picker is
	// invisible while typing /model.
	assert.deepEqual(commands, ["lmstudio-evict-model"]);
});
