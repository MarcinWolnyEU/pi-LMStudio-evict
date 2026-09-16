/**
 * The negative half of `lms load --estimate-only`.
 *
 * The happy path ("This model may be loaded…") is exercised by every other
 * test. The failure path ("This model will fail to load based on your
 * resource guardrails settings.") only appears when LM Studio's own
 * guardrail setting rejects the model, which cannot be provoked through the
 * CLI — the setting lives in the desktop app's settings file.
 *
 * This test therefore *edits LM Studio's own configuration*, so it is
 * **opt-in**: set `PI_LMSTUDIO_EVICT_TEST_GUARDRAILS=1` to run it. It backs
 * the file up first, verifies the backup, restores in a `finally` and again
 * on process exit, and asserts the restore was byte-identical.
 *
 * Verified against LM Studio with `lms` build 71bd99c: the app picks the
 * setting up live, no restart needed. Note that `mode: "strict"` was *not*
 * enough to reject a 17.35 GiB model on a 32 GiB / 16 GiB VRAM machine —
 * only an explicit low `customThresholdBytes` reliably forces the verdict.
 */

import { cleanupAgentDir, preflight } from "./harness.ts";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { estimateMemory } from "../../extensions/lib/lms.ts";

const ENABLE_VAR = "PI_LMSTUDIO_EVICT_TEST_GUARDRAILS";

/**
 * Where the guardrail setting lives, which differs by install:
 *
 *   desktop app  ~/.lmstudio/apps/bionic/.internal/settings.json
 *   headless     ~/.lmstudio/settings.json          (llmster, LM Studio 0.4+)
 */
function settingsPath(): string | undefined {
	const candidates = [
		path.join(os.homedir(), ".lmstudio", "apps", "bionic", ".internal", "settings.json"),
		path.join(os.homedir(), ".lmstudio", "settings.json"),
	];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * The two installs also disagree about where the key sits: the desktop app
 * reads `localModels.modelLoadingGuardrails`, headless llmster reads it at
 * the top level. Writing both is harmless and makes the test install-agnostic.
 */
function applyGuardrails(config: Record<string, unknown>, guardrails: unknown): void {
	const localModels = (config.localModels ?? {}) as Record<string, unknown>;
	localModels.modelLoadingGuardrails = guardrails;
	config.localModels = localModels;
	config.modelLoadingGuardrails = guardrails;
}

after(() => cleanupAgentDir());

test(
	"estimate: reports the negative guardrail verdict when LM Studio would refuse the load",
	{ timeout: 180_000 },
	async (t) => {
		if (process.env[ENABLE_VAR] !== "1") {
			t.diagnostic(
				`skipped: set ${ENABLE_VAR}=1 to run. This test temporarily edits LM Studio's own ` +
					"settings.json (backed up and restored), so it is opt-in.",
			);
			t.skip("opt-in: edits LM Studio settings");
			return;
		}

		const file = settingsPath();
		if (!file) {
			t.diagnostic("LM Studio settings file not found in any known location");
			t.skip("LM Studio settings file not found");
			return;
		}
		t.diagnostic(`using LM Studio settings at ${file}`);

		const { small } = await preflight();
		// The largest model gives the widest margin over the threshold.
		const target = small[1].modelKey;

		const original = fs.readFileSync(file, "utf-8");
		let restored = false;
		const restore = () => {
			if (restored) return;
			fs.writeFileSync(file, original, "utf-8");
			restored = true;
		};
		// Belt and braces: if an assertion throws past the finally, or the
		// runner is killed, still put the user's settings back.
		process.once("exit", restore);

		try {
			const baseline = await estimateMemory(target);
			assert.equal(
				baseline?.passesGuardrails,
				true,
				"precondition: the model should pass the user's existing guardrails",
			);
			t.diagnostic(`baseline verdict for ${target}: passesGuardrails=${baseline?.passesGuardrails}`);

			// Derive the threshold from the model's own estimate rather than
			// using a fixed constant: a tiny model (a 360M GGUF is ~380 MiB)
			// would sail under any hardcoded figure and the test would fail
			// for the wrong reason.
			const threshold = Math.max(1, Math.floor((baseline?.totalBytes ?? 1024 ** 3) / 2));
			t.diagnostic(
				`setting guardrail threshold to ${threshold} bytes, half of the model's ${baseline?.totalBytes}`,
			);

			const config = JSON.parse(original);
			t.diagnostic(
				`original guardrails: ${JSON.stringify(config.localModels?.modelLoadingGuardrails ?? config.modelLoadingGuardrails)}`,
			);
			applyGuardrails(config, {
				mode: "custom",
				customThresholdBytes: threshold,
				alwaysAllowLoadAnyway: false,
			});
			fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
			// The app watches the file; give it a moment to notice.
			await new Promise((resolve) => setTimeout(resolve, 1500));

			const tightened = await estimateMemory(target);
			t.diagnostic(
				`tightened verdict: passesGuardrails=${tightened?.passesGuardrails}, ` +
					`total=${tightened?.totalBytes}, confidence=${tightened?.confidence}`,
			);

			assert.ok(tightened, "the estimate should still be produced under tight guardrails");
			assert.equal(
				tightened.passesGuardrails,
				false,
				"a guardrail threshold at half the model's size should reject it — if this fails, " +
					"either LM Studio's verdict wording changed (parseEstimate needs updating) or " +
					"this install reads the guardrail setting from somewhere else again",
			);
			// The byte figure is unaffected by the guardrail setting; only the verdict moves.
			assert.equal(typeof tightened.totalBytes, "number");
		} finally {
			restore();
			assert.equal(
				fs.readFileSync(file, "utf-8"),
				original,
				"LM Studio's settings must be restored byte-identical",
			);
		}
	},
);
