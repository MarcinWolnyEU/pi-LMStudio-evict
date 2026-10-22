# AGENTS.md

Notes for future AI agents (or future-me) working on this extension. Read this before making changes — it captures the architecture, the data sources, and the things that are only knowable by probing a live LM Studio, so you don't have to rediscover them.

## Orientation

```
pi-lmstudio-evict/
├── package.json        ← pi.extensions points at extensions/evict.ts only
├── README.md           ← user-facing; update when behavior changes
├── AGENTS.md           ← this file
├── LICENSE
├── tsconfig.json       ← no absolute paths; tests/typecheck.mjs fills them in
├── extensions/
│   ├── evict.ts        ← pi entry point: hooks, command, UI
│   └── lib/
│       ├── config.ts       settings + on-disk layout
│       ├── lms.ts          `lms` CLI wrappers + the non-JSON parsers
│       ├── loading.ts      picker loading indicator (BorderedLoader / footer status)
│       ├── memory.ts       RAM/VRAM probes, size formatting, fit grading
│       ├── orchestrator.ts evict-then-preload and heal sequences
│       ├── registry.ts     models.json reconciliation
│       └── sessions.ts     cross-process lock + session claims
└── tests/
    ├── typecheck.mjs               ← discovers pi + @types/node at run time, then runs tsc
    ├── unit/
    │   ├── parsers.test.ts         pure functions, no LM Studio
    │   ├── find-pi.test.ts         managed-install discovery, version validation, launcher / PI_MANAGED_INSTALL_ROOT lookup
    │   └── loading.test.ts         withLoader / withStatus against a fake pi context
    ├── support/
    │   ├── app-child.ts            headless stand-in for a pi session
    │   ├── barrier.ts              cross-process rendezvous (ordering, not sleeps)
    │   ├── event-log.ts            append-only critical-section log + checker
    │   └── find-pi.ts              locates pi across every install layout
    └── integration/
        ├── harness.ts                  preflight, timing, throwaway agent dir
        ├── lock-child.ts               scripted child for the lock race tests
        ├── extension-load.test.ts      pi's jiti loader can import evict.ts
        ├── live-lmstudio.test.ts       the real load/unload/heal sequence
        ├── locking.test.ts             mutual exclusion, lock races, claims
        ├── models-json.test.ts         registration/unregistration policy
        ├── multi-session.test.ts       two real processes via app-child
        └── estimate-guardrails.test.ts opt-in; edits LM Studio's own settings
```

There is no build step; pi loads `.ts` directly via jiti. There are no `node_modules` and no npm dependencies — the code uses `node:` builtins and types from `@earendil-works/pi-coding-agent` (a peer dep, imported type-only so it is erased at runtime — with one deliberate exception, the lazy `BorderedLoader` import in `lib/loading.ts`, described under "pi extension API" below).

**Splitting into `lib/` is safe.** `resolveExtensionEntries()` in pi's package-manager reads `pi.extensions` from package.json and loads only what it lists, so sibling modules under `extensions/` are never picked up as separate extensions.

## Architecture

### Hooks

| Event | What happens |
|---|---|
| `session_start` | Prune dead claims, write this session's claim, reconcile `models.json`, `modelRegistry.refresh()` |
| `model_select` | Update the claim; unless restore / same-model / mid-stream, run `evictThenPreload` in a floating task |
| `before_agent_start` | Heal: if the active model is no longer resident, reload it **before** the turn proceeds |
| `session_shutdown` | Drop this session's claim |

`before_agent_start` is the right hook for healing because pi **awaits** its handlers (`emitBeforeAgentStart` in `dist/core/extensions/runner.js` awaits each one), so the reload finishes before the provider request goes out. `turn_start` is not awaited in the same useful way and fires mid-agent-loop.

### The two sequences (orchestrator.ts)

Both take the cross-process lock, and both are exported so the integration tests drive the real code rather than a copy of it.

- `evictThenPreload({ modelKey, sessionId })` — plan the eviction, unload the victims, then load the target if it isn't already resident. Strictly sequenced: loading before the unload finishes would briefly hold two models, or let `unload --all` kill the load in flight.
- `healIfEvicted({ modelKey, sessionId })` — cheap `lms ps` check; if the model is gone, take the lock, **re-check** (another session may have loaded it while we queued), then load. Deliberately narrow: it reloads the target and evicts nothing, because surprise unloads at prompt time are worse than a stray resident model. The next switch applies the full policy.

`planEviction()` is pure and is where the policy lives: keep one instance of the target, keep everything another live session claimed, unload the rest (including surplus copies of the target).

### Configuration

`<agentDir>/extensions/pi-lmstudio-evict/config.json`, the per-extension layout pi-subagents uses. Agent dir resolution mirrors pi's: `PI_CODING_AGENT_DIR` (with `~` expansion) or `~/.pi/agent`.

```json
{
  "ttlSeconds": 900,
  "healEvictions": true,
  "multiSessionSafety": true,
  "autoRegisterModels": true,
  "useMemoryEstimate": true
}
```

`loadConfig()` returns `{}` on a missing or malformed file — a broken settings file must never break model switching. Everything is read fresh on each use; **don't cache it**, the picker's toggles rely on that.

The same directory holds `lms.lock` and `sessions/<id>.json`.

### Why these specific guards

| Guard | Reason |
|---|---|
| Provider prefix `lmstudio` | Matches both `lmstudio` and `lmstudio/<name>` (multi-server `pi-lmstudio` setups) |
| `source === "restore"` | Session restore is the user expressing intent; forcing a reload would just slow first prompt by the model load time |
| Same-model reselect | `Ctrl+P` cycling can wrap; reselecting the same model shouldn't unload+reload |
| `!ctx.isIdle()` | Unloading the model currently streaming breaks the in-flight response; the heal on the next turn cleans up |
| Residency check before every load | `lms load` on a resident model loads a **second copy** — see below |
| `stdio: "ignore"` | `lms` prints progress spinners; piping would just buffer them in the parent |

## Hard-won facts about `lms`

These were all verified against a live LM Studio 0.3.x. They are not in the docs.

### `lms load <key>` on an already-loaded model loads a SECOND instance

It does not no-op and does not error. You get a second entry in `lms ps` under `<key>:2` (then `:3`…), with the memory cost doubled — the exact failure this extension exists to prevent. **Always check residency before loading.** `matchesModelKey()` handles the `:n` suffix, and `planEviction()` reaps surplus copies.

### `--estimate-only` writes to **stderr**, not stdout

`lms load <key> --estimate-only --yes` leaves stdout empty and prints its whole report to stderr. `lmsText()` therefore concatenates both streams. Output shape:

```
Model: qwen3-coder-30b-a3b-instruct
Context Length: 32 768
Estimated GPU Memory:   17.35 GiB
Estimated Total Memory: 18.00 GiB
Confidence: LOW

Estimate: This model may be loaded based on your resource guardrails settings.
```

From the `lms.exe` internals: `Estimated GPU Memory` is `estimate.memory.totalVramBytes`, `Estimated Total Memory` is `estimate.memory.totalBytes`, both formatted base-1024. The final line has exactly two forms, keyed on `estimate.passesGuardrails`:

- `"This model may be loaded based on your resource guardrails settings."` → true
- `"This model will fail to load based on your resource guardrails settings."` → false

Numbers may be grouped with a non-breaking (U+00A0), thin (U+2009), or narrow no-break (U+202F) space depending on locale; `parseSizeBytes()` handles all three plus ANSI colour codes.

It is fast (~0.5 s) and does **not** load anything.

**The byte figure is worthless on this build; the verdict is not.** Measured across 3 models × 7 parameter combinations on `lms` build 71bd99c, `Estimated Total Memory` was *exactly* `sizeBytes` in all 21 runs, with `Confidence: LOW` throughout. It did not move for `--context-length 4096` vs `262144`, nor for `--gpu off` / `0.5` / `max` — and `--gpu off` still reported a non-zero "Estimated GPU Memory", which is the giveaway that nothing is being computed. Do not repeat the claim that it accounts for KV cache or runtime overhead; it does not, here. Keep the feature for `passesGuardrails`, which is genuinely unavailable elsewhere, and re-measure before making any stronger claim on a newer build.

### The guardrail verdict can be `false`, and here is how to provoke it

The setting lives in LM Studio's desktop config, not in `lms`:

```
~/.lmstudio/apps/bionic/.internal/settings.json
  → localModels.modelLoadingGuardrails = { mode, customThresholdBytes, alwaysAllowLoadAnyway }
```

The app picks up edits to that file **live**, no restart. `mode: "custom"` with a low `customThresholdBytes` (1 GiB) reliably flips the verdict to "will fail to load". `mode: "strict"` did **not** reject a 17.35 GiB model on a 32 GiB RAM / 16 GiB VRAM machine, so don't rely on it. `tests/integration/estimate-guardrails.test.ts` automates this, gated behind `PI_LMSTUDIO_EVICT_TEST_GUARDRAILS=1` because it edits the user's LM Studio configuration (backed up, restored, and verified byte-identical).

### `lms server status --json` gives you the port

`{"running":true,"port":1234}` — use it instead of hardcoding `localhost:1234` when you need a base URL.

### `lms ps --json` and `lms ls --json` cover everything

Between them you get `identifier`, `modelKey`, `sizeBytes`, `ttlMs`, `contextLength`/`maxContextLength`, `paramsString`, `architecture`, `quantization`, `vision`, `trainedForToolUse`, `type`, `status`. **The REST API is not needed** — avoiding it also avoids assuming a port. `identifier` is the unload handle; `modelKey` is the stable identity.

`lms ps` `status` is `"idle"` for a ready model, not `"loaded"`. Presence in the array is the load signal.

### A model appears in `lms ps` seconds before it is loaded — and that is fine

Measured on a 6.7 GiB model: the entry showed up **7.6 s before `lms load` exited** (8.93 s vs 16.55 s on a cold read; ~1 s vs ~9 s when the file was in page cache). While loading:

- `status` is `"idle"` — **identical to a ready model. It is not a readiness signal.**
- `contextLength` is a placeholder `8192`, settling to the real `262144` afterwards.
- `lastUsedTime` is `null`, but that is also true of a freshly-loaded, unused model.

Diffing the full `lms ps` record mid-load against post-load, *only* `contextLength` and `lastUsedTime` change. **There is no field that means "still loading".**

This is exactly what we want. A chat completion sent to a mid-load model returns **HTTP 200** — LM Studio queues it until the model is ready (7.84 s in the measurement, versus 178 ms once warm) rather than erroring. So treating a loading model as resident is correct on both counts: `planEviction` declines to start the duplicate `<key>:2` load, and a skipped heal costs nothing because the request would have waited anyway. `live-lmstudio.test.ts` has a regression test that starts a load, waits for the entry to appear, and asserts `evictThenPreload` reports `alreadyResident` and leaves exactly one instance.

The one visible artefact: the picker can momentarily render `ctx 8192/262144` for a model that is still loading. Cosmetic — don't trust `contextLength` from an entry that only just appeared.

### `models.json` tolerates extra keys

pi's schema (`ModelsConfigSchema` in `dist/core/model-config.js`) is a TypeBox object without `additionalProperties: false`, so `"managedBy": "pi-lmstudio-evict"` round-trips fine. Verified by running pi's own `ModelConfig.load()` over a generated file — the integration test still does this on every run, so a future schema tightening will be caught.

`ModelConfig.load` also runs `stripJsonComments`, so a user's models.json may legitimately contain comments. We reserialize with `JSON.stringify`, which drops them — one more reason only managed entries are rewritten and the first change leaves a backup.

## Cross-process locking (sessions.ts)

`fs.openSync(path, "wx")` is the atomic primitive: exactly one process creates the file per round.

### The race you cannot fix, and what we do instead

Breaking an abandoned lock takes two syscalls — decide it is stale, then unlink — and nothing makes that pair atomic. A breaker can therefore always delete a lock somebody else legitimately acquired in between. **The token re-check before the unlink does not close this**; it only narrows it. The interleaving does not even need a third process: two waiters both see stale holder H, both pass the re-check, B unlinks/creates/enters, then A's unlink deletes *B's live lock* and A enters too. Measured window on the dev machine: p50 ~340 µs, max 18.3 ms.

Node core offers no `flock` (nodejs/node#54446, closed as not planned), so there is no OS-owned primitive to fall back on. `proper-lockfile` has the same hole and answers it the same way we now do — by **detecting** theft rather than preventing it:

| Mechanism | Purpose |
|---|---|
| Heartbeat: `utimesSync` every `HEARTBEAT_MS` (5 s) on an **unref'd** timer | Keeps a live lock fresh so `LOCK_STALE_MS` can be 30 s instead of the minutes a model load needs. Fewer break decisions ⇒ fewer chances to race |
| Staleness from `stat.mtime`, not the record's `at` | The holder cannot forge it, and the heartbeat refreshes it |
| `handle.isValid()` / `compromised` | `evictThenPreload` checks it immediately before unloading. Shrinks exposure from the whole multi-minute sequence to one token read, and returns `abandoned: true` rather than double-evicting |
| `bootTime` in the record | A lock predating the current boot is dead whatever the PID table says — kills PID reuse across reboots. Boot times agree across processes to ~13 ms; tolerance is 5 s |
| `host` in the record | Never PID-check a foreign host; the agent dir can be on a synced share |
| One break per acquire attempt | Stops two processes cascading into breaking each other |
| Poll jitter `pollMs * (0.5 + random())` | Without it every session waking from a laptop suspend polls in the same instant and all decide the lock is stale together — the worst case for the break race |

`withLock` **runs the body anyway** when the lock can't be taken — a stuck lock file must never stop a user from switching models.

### Two bugs that were real, and their regression tests

- **An unparseable lock file used to be permanently unbreakable.** `readLock()` returned `undefined`, and the `holder && (…)` guard then skipped the break branch, so every acquirer spun until the 10-minute timeout, forever. Reachable by a crash between `open(wx)` and `write`, by ENOSPC, and — the one that would actually ship — **a future version writing a different record shape while an old version runs in another pi window**. Now: an unreadable file is breakable after `UNREADABLE_GRACE_MS` (5 s), which is far longer than the ~300 µs open→write window. Tested four ways, plus a child that really crashes mid-create.
- **`release()` leaked the lock when the file read back empty.** `undefined !== token` sent it down the "someone else owns it" path. Now it distinguishes "read a different token" (leave it) from "couldn't read" (decide by mtime — if it predates our last heartbeat write it is ours).

### Timers and staying alive

This has bitten three times now, always the same way: **Node exits the moment its event loop empties, and neither an unref'd timer nor an unref'd child process is a reason to stay.** The symptom is always `code 13` and "Detected unsettled top-level await".

The rule: *if you await something and act on the result, hold the loop open until it settles.*

| Thing | Referenced? | Why |
|---|---|---|
| Lock poll timer (`sessions.ts`) | **Yes** | An unref'd poll lets a process exit while waiting its turn, silently dropping the eviction it was queued to perform |
| Heartbeat timer (`sessions.ts`) | No | A heartbeat must never be the reason a process stays alive |
| `lmsBackground(..., { keepAlive: true })` in the heal | **Yes** | The turn is being held open for this load. Without it a host without a TUI exits mid-load — found by the headless harness |
| `lmsBackground(...)` in the eviction task | No | Fire-and-forget; must never stop pi quitting. `detached` means the load survives either way |
| `HEAL_WAIT_MS`, estimate budget (`evict.ts`) | No | The other side of the race is the real work |

pi's TUI hides this in normal use by keeping stdin open, which is exactly why it needed a headless harness to surface. Anything that stands in for pi must model that keep-alive too — `tests/support/app-child.ts` holds a plain interval for the life of its script.

### Claims

Honoured only when the owning PID is alive and `updatedAt` is within `CLAIM_STALE_MS` (24 h, a backstop against PID reuse). A claim from another `host` skips the PID check entirely and rests on freshness alone, and is never pruned — we cannot judge another machine's liveness. Claims are refreshed on `model_select` and before every turn, and pruned both on `session_start` and inside `evictThenPreload`'s locked section (a hard-killed session's file would otherwise linger forever if pi were never launched again).

## Tests

`npm test`, or `test:unit` / `test:integration`. Node's built-in runner and type stripping — needs Node 22.18+ / 24+, no dependencies. `--test-concurrency=1` is essential: the integration tests share one LM Studio. A full green run is **85 passing, 1 skipped** (86 tests) (~3–7 minutes, most of it real model loads).

**Known flake, cause identified: another client on the same LM Studio.** `multi-session.test.ts` › "heal fires through the real entry point…" passed in isolation and in file-only runs, but failed in three of five runs made while other agents were using the machine's LM Studio. The failures differed each time (a stray extra model and a duplicate `google/…` instance right after the load, a 237 s load instead of ~10 s, a model that reappeared during the 16 s cache-expiry sleep with no heal notification). The cause was another agent loading and unloading models that the test could not see; the test assumes nothing else touches LM Studio. If it fails, rerun it alone with `--test-name-pattern="heal fires"` with every other pi/LM Studio client closed before suspecting the lock; a persistent failure in that state is a real bug.

The one skip is `estimate-guardrails.test.ts`, opt-in behind `PI_LMSTUDIO_EVICT_TEST_GUARDRAILS=1` because it edits LM Studio's *own* settings file to force the negative guardrail verdict. It backs up, restores in a `finally` **and** on `process.exit`, and asserts the restore was byte-identical. Run it before touching `parseEstimate`.

**A skipped or degraded pi-dependent test means `find-pi.ts` missed your layout, not that the test passed.** `extension-load` and `multi-session` skip with "pi not installed". `models-json` does *not* skip: its pi half falls back to a bare JSON-parse check and passes, leaving only the diagnostic line "falling back to a JSON parse check" — so a green `models-json` run proves nothing about pi's schema unless that line is absent. All of this happened silently on a managed install until the layout was added.

`find-pi.ts` tries, in order: `./node_modules`, the managed install of the running launcher (`PI_MANAGED_INSTALL_ROOT`, which the launcher sets for the pi it spawns, then a `pi-launcher.js` directory on `PATH`), the npm-global layouts next to node, managed installs found by convention (`PI_CODING_AGENT_DIR`, `~/.pi/agent`), then `npm root -g`. The launcher goes ahead of the npm layouts so a stale global copy cannot shadow the install `pi` really runs, and it goes by `PATH` rather than the env var because the harness overwrites `PI_CODING_AGENT_DIR` with a temp dir. pi's dependencies (`jiti`, `@types/node`) may be hoisted beside pi rather than nested under it, so both spots are checked. `unit/find-pi.test.ts` plants real fake packages at every traversal target for `current-version`, so the validation is the only thing that can make those cases fail.

`npm run typecheck` goes through `tests/typecheck.mjs` rather than `tsc -p` directly. `tsconfig.json` deliberately contains **no absolute paths**: pi and its bundled `@types/node` live somewhere different on every machine (next to the node binary on Windows/nvm4w, under `<prefix>/lib/node_modules` on Unix, anywhere at all with a custom npm prefix, or in pi's *managed install* at `<agent dir>/install/releases/<current-version>/node_modules` — the layout `pi.dev`'s installer creates, with no global npm package at all), so the script discovers them at run time — `tests/support/find-pi.ts`, falling back to `npm root -g` — and generates a tsconfig that extends the committed one. An earlier version hardcoded `C:/nvm4w/...` and failed on Linux.

The integration suite **fails** rather than skips when LM Studio isn't usable; skipping would let a broken extension look tested. It discovers the two smallest non-embedding models from `lms ls` (nothing hardcoded, no assumed install path), unloads whatever was resident before starting, and times every step.

**Portability, verified on Ubuntu 24.04 / Node 24 against a real headless LM Studio:** zero product failures. Two things to keep in mind when adding tests. `process.kill(0, 0)` does *not* throw on Linux — PID 0 means "my whole process group" — so the `pid <= 0` guard in `isProcessAlive` is load-bearing, not defensive. And **`999_999` is a perfectly reachable PID on Linux** (systemd sets `pid_max` to 4194304; a process was successfully forced onto that exact number), so never use it as a "definitely dead" constant — use the `deadPid()` helper, which spawns a process and waits for it to exit. `999_999_999` *is* safe, since the kernel hard-caps `pid_max` at 4194304.

`harness.ts` points `PI_CODING_AGENT_DIR` at a fresh temp directory **at import time**, so config, claims, locks and `models.json` all land in a throwaway location. Test files must import the harness **first** — the library reads the env var on each call, so the redirect only holds if it happens before anything else runs. `models-json.test.ts` asserts at the end that the real `models.json` was never written.

Node runs each test *file* in its own process, so each file gets its own temp agent dir and prints its own timing table.

`locking.test.ts` spawns real child processes (`lock-child.ts`, deliberately not named `*.test.ts`). An in-process test would pass even if the lock were a module-level boolean, which is exactly the bug that matters when a second pi window is open.

Its race tests steer two children through one exact interleaving with **barrier files plus the `hooks` seam in `sessions.ts`**, not sleeps — so they are deterministic in both directions rather than flaky. `SIGSTOP` would be the obvious tool and does not exist on Windows (`process.kill` throws `ERR_UNKNOWN_SIGNAL`). The `hooks` interface is `@internal`, synchronous-only so no `await` point can enter the critical path through it, and unreachable unless a caller passes it.

Mutual exclusion is asserted from an **append-only event log** (`tests/support/event-log.ts`) walked in file order, not by comparing each process's own start/end timestamps — timestamp comparison cannot see a violation shorter than the clock skew between two processes. `O_APPEND` line atomicity was measured on this platform (8 writers, records to 4211 B, zero torn lines); it requires one `writeSync` per record and does not hold on NFS/SMB.

The stale-break test asserts the *achievable* property, not an impossible one: **either mutual exclusion held, or the victim detected the theft**. On the dev machine it reliably reproduces the violation (`max concurrent 2`) and the victim reports `stillValid: false, compromised: true`.

**Note for anyone adding to `tests/support/`:** Node runs these through *strip-only* type removal, which rejects TypeScript parameter properties (`constructor(readonly x: string)`). Assign fields explicitly.

Statistical note worth keeping: the four-child contention test has **zero power** against the stale-break race, because no stale holder is ever present so the break branch never runs. No number of iterations changes that. Stress aimed at that race would have to manufacture break events with a dedicated crasher; the deterministic test is what actually proves the property.

`extension-load.test.ts` imports `evict.ts` through **pi's own bundled jiti** and drives the factory with a stub `ExtensionAPI`. Every other test imports `lib/` directly, so this is the only one that would notice if jiti stopped resolving the `./lib/*.ts` specifiers — a failure mode where pi still starts, the extension silently does nothing, and the rest of the suite stays green.

`multi-session.test.ts` drives the **real extension entry point in two concurrent OS processes** via `tests/support/app-child.ts`, which loads `evict.ts` through pi's own jiti loader, hands it a stub `ExtensionAPI`, and replays a scripted event sequence. Both children share one `PI_CODING_AGENT_DIR`, so the lock, the claim files and the `lms` calls are all real. Barriers synchronise them, which is how the simultaneous-switch case is reproduced *exactly* rather than by hand-timing two terminals.

This is the layer that found the `keepAlive` bug above, and it is worth more than a two-TUI test: it covers everything except the terminal renderer, and the renderer is not what can corrupt LM Studio's memory. Keep one manual TUI smoke run for release, not for CI.

Three traps when writing tests here, all learned by hitting them:

- **A child parked on a barrier keeps the runner alive** through the spawn handle. One failed assertion then hangs the whole file *and* swallows the failure message. Always `t.after(() => releaseAll(ws))`.
- **Cleanup must be scoped to the workspace that spawned the children.** A global "kill everything after 5 s" reaped the next test's children and failed two tests at exactly 5023 ms.
- **Attach a `.catch()` to a child promise you await later.** An early rejection otherwise surfaces as an unhandled rejection against whatever test is running, while the real body waits out its full timeout.

Things the tests deliberately do *not* cover: the picker UI (needs a pi TUI), and restoring whatever LM Studio had loaded before the run (that would cost minutes of reloading; the suite leaves LM Studio empty and says so).

## pi extension API: the relevant bits

Events used:
- `model_select` — fields `model`, `previousModel`, `source` (`"set" | "cycle" | "restore"`)
- `before_agent_start` — fires after the user submits, before the agent loop; **awaited**, and can replace the system prompt
- `session_start` — `reason: "startup" | "reload" | "new" | "resume" | "fork"`
- `session_shutdown` — `reason: "quit" | "reload" | "new" | "resume" | "fork"`

`ctx` bits used: `ctx.model` (`provider`, `id`), `ctx.mode` (`"tui" | "rpc" | "json" | "print"`; `ctx.ui.custom` only works in `"tui"`), `ctx.isIdle()`, `ctx.ui.*`, `ctx.modelRegistry.refresh()` (reloads models.json asynchronously — await it before synchronous registry reads).

`ctx.ui.select()` returns the chosen **label**, so labels must be unique; the picker deduplicates with a `#n` suffix. Colors come from `ctx.ui.theme` — the `theme` singleton is not exported from the package root and the exports map blocks deep imports, so the UI context is the only sanctioned way to reach the live theme.

**Loading state in the picker.** The handler gathers `lms ps`/`ls`/VRAM/estimates inside `withLoader()` (in `lib/loading.ts`, so it can be unit-tested with a fake context), which shows pi's `BorderedLoader` through `ctx.ui.custom()` (cancellable; its `signal` stops `collectEstimates` pulling more work). `BorderedLoader` is exported from the package root and is a *runtime* import, the only one in the extension — hence the lazy `await import()` inside a `try`: pi is only a peer dependency, and `extension-load.test.ts` loads `evict.ts` with a bare jiti that has none of pi's virtual modules, so a static import could stop the module loading there (precaution; that test skips on machines where `find-pi.ts` can't locate pi). The lazy import was checked to resolve under pi's Node-mode jiti aliasing; the compiled-binary `virtualModules` mode has not been exercised. Outside `ctx.mode === "tui"` it uses the footer status; if the import fails *in* the TUI it does the same but raises a warning notification, so a broken import is visible instead of silently costing every picker its spinner. A rejection inside the gathering work is re-thrown after the loader closes, **not** treated as a cancel — Escape and failure both close the loader the same way, and swallowing the failure would leave a vanished spinner and no message. A rejection that arrives after Escape is dropped. Slow actions (load/unload/sync) use `withStatus()` for the footer line, on its own key (`COMMAND_STATUS_KEY`) so a picker action finishing cannot clear the "loading…" of a model switch made meanwhile. Escape stops queued estimates but not `lms` processes already running; those finish within their timeout and the results are dropped. Other loading primitives pi offers, not used: `ctx.ui.setWidget`, `setWorkingMessage`/`setWorkingIndicator` (those belong to the streaming loader, not commands).

The picker is registered under four names (`COMMAND_NAMES` in `evict.ts`): `lmstudio-evict-model`, `llm-evict-model`, `model-load-unload`, `llm-load-unload`. pi has no alias feature; each name is a separate `registerCommand` call with the same options object. The palette fuzzy-matches on command *names* only, and "model" is not a subsequence of "lmstudio-evict", so the extra names are what make the picker visible while typing `/model`, `/llm`, `/load` or `/unload`. **Don't drop a name without checking the keywords it covers.** Both integration tests assert the exact list.

## Ideas not built

- **Load with the right context length.** `lms load --context-length N` exists and `event.model.contextWindow` is available. Would fix LM Studio loading a coder model at its small default. Not done: interacts with the residency check (a resident model loaded at the wrong context would need an unload/reload to fix, which conflicts with "never reload what's already there").
- **Passive footer widget** listing what's in memory. `ctx.ui.setStatus` is already used for transient progress; a permanent line would need a refresh policy.
- **RAM-pressure LRU eviction** with a protect-list, as `lm-studio-warm-core` does, instead of "one model at a time".
- **Broader VRAM sources** — AMD via `rocm-smi`, Apple Silicon unified memory as one pool. Today `memory.ts` degrades to RAM-only off NVIDIA.
- **Optional unload on exit** via `session_shutdown`, off by default.

## Other notes

- **Cross-platform:** the only OS-specific bits are `windowsHide: true` in the spawn options (don't remove it; LM Studio on Windows spawns a console window otherwise) and `nvidia-smi` being NVIDIA-only.
- **Logging:** there is none. If you add diagnostics use `console.log`; pi surfaces extension logs in `--verbose`. The extension is supposed to be invisible, so keep it quiet.
- **Beware invisible characters in source.** `lms.ts` builds its regexes with `new RegExp` from `\u` escapes precisely because literal ESC/NBSP/thin-space characters get mangled by tooling. Keep it that way.
