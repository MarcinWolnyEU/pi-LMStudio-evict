# pi-lmstudio-evict

Keep one LM Studio model loaded while you work in the [pi coding agent](https://pi.dev). When you switch models with `/model`, this extension unloads the previous model, preloads the one you picked, and puts it back later if LM Studio's idle TTL threw it out. Two models never sit in VRAM at once just because you changed your mind.

## If this sounds familiar

- You switched models in pi, but `lms ps` still shows the old one. VRAM is full and the machine is swapping.
- "Only Keep Last JIT Loaded Model" is on in Developer > Server Settings, and the previous model stays loaded anyway.
- Your first prompt after a switch hangs for a minute while LM Studio loads the model.
- You come back after lunch, the idle TTL has unloaded the model, and the next prompt stalls or errors out.
- The same model shows up twice in LM Studio, eject button on both, memory doubled.

## What it does

When you switch models in pi, the extension unloads what LM Studio is holding and immediately starts loading the model you just picked. Old models don't pile up in RAM, and the new one warms up while you type your first prompt.

On top of the switch itself:

- If a model gets evicted mid-session (idle TTL fired, you unloaded it in the GUI, or a switch was skipped because the agent was streaming), the next prompt reloads it before the request goes out.
- Other pi sessions are left alone. Each session publishes the model it's using, an eviction skips models another live session has claimed, and a cross-process lock stops two windows from interleaving into "both models loaded".
- `models.json` stays in step with LM Studio. Models you download appear in `/model` without hand-editing JSON, and models you delete stop haunting the picker.
- Models are sized by LM Studio's own estimate (`lms load --estimate-only`) rather than raw file size, and the picker shows what each model is: parameters, quantization, architecture, vision and tool support, context length.

## Why LM Studio's Auto-Evict isn't enough

LM Studio ships an Auto-Evict setting ("Only Keep Last JIT Loaded Model" under Developer > Server Settings), and it's on by default. So why do models still pile up?

LM Studio has two ways of loading a model. JIT loading happens when a request hits `/v1/chat/completions` and the model isn't in memory yet. Those models get the idle TTL and are what Auto-Evict acts on. Everything else counts as manually loaded: anything loaded from the GUI, with `lms load`, or through `POST /api/v1/models/load`, which is how several agent clients preload models. Manually loaded models have no TTL and Auto-Evict never touches them (see [lmstudio-bug-tracker #2051](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2051) and [#644](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/644)). This extension's own preloads go through `lms load` too, so it does its own unloading rather than relying on Auto-Evict. `lms unload` makes no exception for how a model got there.

Two more gaps, even for JIT-loaded models:

- Auto-Evict only acts when a request arrives, so your first prompt after a switch absorbs the whole load time. Ten seconds to two minutes for a 12B, longer for a 30B. The extension starts loading the moment you pick the model.
- JIT models carry a 60-minute idle TTL by default, so a session you come back to after a break stalls on a cold load. Models this extension loads are pinned, and reloaded if something removes them anyway.

## Installation

```bash
pi install npm:pi-lmstudio-evict
```

Or add it to `~/.pi/agent/settings.json` by hand. The `npm:` prefix matters: pi treats a bare name as a local path.

```json
{
  "packages": [
    "npm:pi-lmstudio-evict"
  ]
}
```

To run from a local clone instead, use the absolute path to the clone in place of the npm source (on Windows, escape the backslashes: `"C:\\path\\to\\pi-lmstudio-evict"`). To try it once without installing: `pi -e npm:pi-lmstudio-evict`.

Then `/reload` in pi, or restart it.

## Requirements

- pi (`@earendil-works/pi-coding-agent`, declared as a peer dependency)
- LM Studio, with the local server running (or `startServer: true`)
- The `lms` CLI (ships with LM Studio). Found on `PATH`, else in LM Studio's own `~/.lmstudio/bin`, so a pi started from a GUI launcher or non-login shell still finds it; set `LMS_PATH` to point somewhere else
- A pi provider for LM Studio, for example [`pi-lmstudio`](https://www.npmjs.com/package/pi-lmstudio) or a hand-written `lmstudio` block in `~/.pi/agent/models.json`

## Behavior

| Trigger | Action |
|---------|--------|
| `/model` to a different LM Studio model | Unload what should go, then preload the new model |
| `Ctrl+P` cycling to a different LM Studio model | Same |
| `--model lmstudio/...` on the command line | Same |
| Prompt sent while the active model is no longer loaded | Reload it first (see **Healing**) |
| Prompt sent while the active model is loaded at the wrong context | Unload it, then reload it at the right one (see **Context length**) |
| Session start | Sync `models.json` with LM Studio's catalogue; start the server if `startServer` is on. On a fresh start (not resume) on an LM Studio model, unload what should go and preload it, as a switch would: pi fires no `model_select` for the model it starts on |
| pi quits normally | Unload this session's model if `unloadOnQuit` is on and no other live session claims it; stop the server if `stopServerOnQuit` is on and this was the last session |
| Session restore picking an LM Studio model | No-op (would force a redundant reload) |
| Reselecting the same model | No-op, and never a second copy (see below) |
| Switching to a non-LM-Studio model (Anthropic, OpenRouter, etc.) | No-op, and this session stops claiming a model |
| `lms` missing, or local server down with `startServer` off | No-op, silent |

The switch itself is fire-and-forget. It runs in the background, so pi never blocks on a model load, and progress appears in the footer. The load starts only after the unload has finished; otherwise two large models could sit in memory at once.

By default the preload sets no TTL: the model is pinned and stays loaded until the next switch. If you'd rather have idle models unload themselves, set a TTL in the settings menu. A TTL is also the only thing that unloads a model after pi is hard-killed: `unloadOnQuit` needs a normal quit to run.

There is never a second copy. `lms load` on an already-loaded model does not no-op: LM Studio loads a *second* instance under `<key>:2` and doubles the memory. The extension checks what's loaded before every load, and reaps surplus copies if it finds them.

## Healing

Before each turn, the extension checks that the active model is still loaded and reloads it if not. This covers the LM Studio idle TTL, a manual unload in the GUI, and the mid-turn switch that gets skipped on purpose.

The check is one `lms ps` call (about 0.5 s) and is skipped when the model was confirmed loaded in the last 15 seconds, so rapid back-and-forth prompting doesn't pay for it. When a reload is needed the turn waits for it, capped at 5 minutes, after which the prompt goes through and LM Studio just-in-time loads the model itself.

With a context length configured, the heal also replaces a copy loaded at the wrong context (see **Context length**).

Turn it off with `healEvictions: false`.

## Context length

LM Studio loads a model at its own per-model default unless told otherwise, and that is often far below what pi budgets for. The symptom is an error on the first long prompt: "The number of tokens to keep from the initial prompt is greater than the context length".

Every load this extension performs can pass `--context-length`. The value comes from, in order:

1. the `contextWindow` of a **hand-written** `models.json` entry for that model (any `lmstudio*` provider), when `matchContextWindow` is on (off by default, since it changes how existing entries load). pi then really gets the window it budgets for. Generated entries are skipped: theirs is the model's *maximum* context, which can be 256k and more than the machine can hold;
2. the global `contextLength` setting;
3. nothing: LM Studio's default, as before.

A model already loaded at a different context (typically a just-in-time load at the default) is unloaded and reloaded at the right one: by the heal before a turn, and by a model switch. It is unloaded **first**, so there is never a `<key>:2` copy. A copy is left alone when another live session claims it, and while it is still loading, so a load in flight is never cut off.

## Multiple pi sessions

Each session writes a claim (`<agent dir>/extensions/pi-lmstudio-evict/sessions/<id>.json`) naming the model it's using. An eviction spares every model claimed by another *live* session, and a lock file serialises the evict-then-load sequence across processes. Liveness is checked by PID, so a crashed session protects nothing.

The result: switching models in one window no longer pulls the model out from under another. Manual unloads from the picker are still unconditional; that's you asking for it.

Verified with two and three concurrent pi sessions: live claims are honoured, a clean quit releases the claim within seconds, a hard-killed session (`taskkill /F`) protects nothing, and simultaneous switches in two windows never produced a duplicate `<key>:2` load.

One loaded model is eventually consistent, not instantaneous. When two sessions switch off the same model at the same moment, each spares the other's model because the other's claim still names the *old* one, so memory can briefly hold two models for about one load duration before converging. That's the conservative trade: the alternative is evicting a model another session is about to use.

Turn it off with `multiSessionSafety: false` to get blanket `lms unload --all` back.

## Model registration

On session start, the LM Studio provider block in `<agent dir>/models.json` is reconciled against `lms ls`: new models are added, models that no longer exist on disk are removed, and metadata (context window, vision) is refreshed.

Only entries this extension created are ever touched. Ownership is recorded as `"managedBy": "pi-lmstudio-evict"` on the entry. A hand-written entry is left exactly as it is, and its id counts as taken so it never gets shadowed by a generated duplicate. Delete the `managedBy` key to adopt an entry; add it to hand ownership back.

Other safeguards: writes are atomic (temp file plus rename), a `models.json` that doesn't parse is never overwritten, and the first modification leaves a one-time `models.json.bak-pi-lmstudio-evict`.

Turn it off with `autoRegisterModels: false`.

## Commands

`/lmstudio-evict-model` opens a picker over LM Studio's model catalogue. The same picker is also available as `/llm-evict-model`, `/model-load-unload` and `/llm-load-unload`: pi's command palette matches on names, so it shows up whichever of `/model`, `/llm`, `/load` or `/unload` you start typing.

```
LM Studio models — RAM 41.2 GiB free of 63.9 GiB · VRAM 9.8 GiB free of 24.0 GiB
● qwen3-coder-30b-a3b-instruct — 18.6 GiB · 30B Q4_K_M qwen3moe · tools · ctx 32768/262144 — unload
○ gemma-3-12b-it — 8.1 GiB · 12B Q4_K_M gemma3 · vision · ctx 131072 — load
○ devstral-small-2507 — 14.3 GiB (file) · 24B Q4_K_M mistral3 · tools · ctx 131072 — load
⟳ Sync models.json with LM Studio now
⚙ Settings…
```

- `●` loaded models (name in green): select one to unload it. An "unload all" entry appears when more than one is loaded.
- `○` on-disk models: select one to load it in the background. Embedding models are hidden.
- `⟳` reconciles `models.json` now, without waiting for the next session start.
- `⚙` opens the settings: TTL, context length, extra load flags, and the toggles below. The menu stays open after each change so several can be flipped in one visit. Escape returns to the model list, and Escape there closes the picker.

Each row shows what the model is: parameters, quantization, architecture, vision and tool support, and context length (current/max for loaded models).

The title shows free system RAM, and free VRAM on NVIDIA machines (read via `nvidia-smi`, omitted when that's not available; LM Studio itself exposes no hardware info).

A not-yet-loaded model's size comes from `lms load --estimate-only`, LM Studio's own projection of the load. Sizes fall back to file size (marked `(file)`) when the estimate isn't available in time.

The size is coloured by whether it can fit right now: orange when it exceeds free RAM or free VRAM alone, red when it exceeds both combined or when LM Studio says the load would fail its own resource guardrails. Sizes of already-loaded models are left uncoloured, since their memory is already spent and the comparison would always flag them.

> What the estimate is actually worth: measured against LM Studio (`lms` build 71bd99c) across three models and seven parameter combinations, `--estimate-only` returned *exactly* the file size every time, unchanged by `--context-length` and by `--gpu off|0.5|max`, always with `Confidence: LOW`. On that build the byte figure tells you nothing `lms ls` doesn't already say for free. The part that *is* additive is the guardrail verdict, which reflects settings this extension cannot otherwise see and is what drives the red colouring. Set `useMemoryEstimate: false` to skip the calls entirely.

## Configuration

Settings live in `<agent dir>/extensions/pi-lmstudio-evict/config.json` (usually `~/.pi/agent/extensions/pi-lmstudio-evict/config.json`). The settings menu manages the file for you; editing it by hand works too.

```json
{
  "ttlSeconds": 900,
  "contextLength": 32768,
  "matchContextWindow": true,
  "extraLoadArgs": ["--gpu", "max"],
  "modelLoadArgs": { "qwen/qwen3.5-9b": ["--parallel", "2"] },
  "startServer": true,
  "unloadOnQuit": true,
  "stopServerOnQuit": false,
  "healEvictions": true,
  "multiSessionSafety": true,
  "autoRegisterModels": true,
  "useMemoryEstimate": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `ttlSeconds` | *(unset)* | Passed as `--ttl` to every `lms load` this extension performs, so LM Studio unloads the model after that much idle time. When unset, loaded models are pinned. |
| `healEvictions` | `true` | Reload the active model before a turn if something unloaded it. |
| `multiSessionSafety` | `true` | Spare models other live pi sessions have claimed instead of unloading everything. |
| `autoRegisterModels` | `true` | Keep `models.json` in step with LM Studio's catalogue. |
| `useMemoryEstimate` | `true` | Size models in the picker via `lms load --estimate-only` instead of file size. |
| `contextLength` | *(unset)* | Passed as `--context-length` to every load, for models without a hand-written `contextWindow`. See **Context length**. |
| `matchContextWindow` | `false` | Load at the `contextWindow` of a hand-written `models.json` entry. |
| `extraLoadArgs` | *(unset)* | Extra `lms load` flags for every load, e.g. `["--gpu", "max", "--parallel", "2", "--speculative-draft-mtp"]`. See `lms load --help` for what your LM Studio supports; an unknown flag makes the load fail. Flags the extension sets itself (`--context-length`/`-c`, `--ttl`, `--identifier`, `--yes`/`-y`, `--estimate-only`) are dropped. |
| `modelLoadArgs` | *(unset)* | Per-model extra flags, keyed by model key; added after `extraLoadArgs`. Config file only. |
| `startServer` | `false` | Run `lms server start` when an LM Studio model is in use and the server is down: on session start, before a switch, and before the heal check. |
| `unloadOnQuit` | `false` | On a normal quit, unload this session's model unless another live session claims it. |
| `stopServerOnQuit` | `false` | On a normal quit, stop the server when no other pi session is alive. Other apps may use it, so think before turning it on. |

Everything is read fresh, so a change applies to the next operation without a reload.

## Verification

After installing, in pi:

1. Get two LM Studio models loaded (prompt each once, or `lms load` them), then confirm with `lms ps` in another terminal
2. `/model`, pick a different LM Studio model
3. `lms ps` again. Without sending a prompt, the old models should be gone and the new one should appear (loading, then ready)
4. `lms unload --all`, then send a prompt in pi. The model should be reloaded before the response starts

## Tests

The suite runs against the LM Studio on your machine. It picks the two smallest non-embedding models it finds, so nothing is hardcoded, and it unloads whatever was already loaded before starting rather than assuming a clean slate. Every step is timed and the durations are reported.

```
npm test              # everything
npm run test:unit     # parsers and planners, no LM Studio needed
npm run test:integration
npm run typecheck
```

The integration tests fail, rather than skip, when LM Studio isn't running or has fewer than two chat models, so a green run means the behaviour was exercised. They redirect `PI_CODING_AGENT_DIR` to a temporary directory, so your own config and `models.json` are never touched. They do leave LM Studio with no models loaded.

A full run is 110 tests and takes a few minutes, most of it real model loads. What they cover:

| Area | How it's tested |
|---|---|
| Evict, preload, switch, heal | The real sequences against live LM Studio |
| Multi-session safety | Two concurrent OS processes running the real extension through pi's own loader, synchronised by barriers so simultaneous switches are reproduced exactly |
| Cross-process locking | Four real child processes for exclusion, plus a forced stale-break interleaving that proves the victim detects a stolen lock |
| `models.json` policy | Synthetic catalogues for the ownership rules, then the real catalogue validated by pi's own schema loader |
| Extension loading | Imported through pi's bundled jiti, the way pi does it |

One test is opt-in and reports itself as skipped unless you enable it: the negative guardrail verdict ("this model will fail to load based on your resource guardrails settings"). LM Studio only produces that verdict from its own guardrail setting, which lives in the desktop app's settings file and can't be set from the CLI, so the test temporarily edits that file (backed up first, restored in `finally` and again on process exit, and asserted byte-identical). Nothing else in the suite touches LM Studio's configuration, which is why this one asks for consent. One test does briefly stop and restart LM Studio's local server, to prove `startServer`; it restarts it in a `finally` if it was running, but any other client of the server sees a few seconds of downtime. To run all 110 with nothing skipped:

```bash
PI_LMSTUDIO_EVICT_TEST_GUARDRAILS=1 npm test          # bash
$env:PI_LMSTUDIO_EVICT_TEST_GUARDRAILS = "1"; npm test  # PowerShell
```

It also skips, with a diagnostic naming the paths it tried, if it can't find LM Studio's settings file at `~/.lmstudio/apps/bionic/.internal/settings.json` (desktop) or `~/.lmstudio/settings.json` (headless).

Verified on Windows 11 and on Ubuntu 24.04 with headless LM Studio.

Requires Node 22.18+ or 24+ (the tests are TypeScript, run through Node's built-in type stripping and `node:test`). No npm dependencies. `npm run typecheck` locates pi and its bundled `@types/node` at run time rather than hardcoding paths.

## Compatibility

- Provider matching: any provider whose name starts with `lmstudio`, including multi-server setups from [`pi-lmstudio`](https://www.npmjs.com/package/pi-lmstudio) (e.g. `lmstudio/desktop`).
- `models.json`: works with hand-written entries (left untouched) and alongside dynamic-discovery extensions.
- pi fork: targets `@earendil-works/pi-coding-agent`. Other forks (e.g. `@oh-my-pi/pi-coding-agent`) may work but are untested.

## Works alongside

None of these do what this extension does, and this extension doesn't do what they do. Most people will run one from the first row plus this one.

| Package | What it does | Overlap with pi-lmstudio-evict |
|---|---|---|
| [pi-lmstudio](https://www.npmjs.com/package/pi-lmstudio), [pi-lm-providers](https://www.npmjs.com/package/pi-lm-providers), [pi-localllm-provider](https://www.npmjs.com/package/pi-localllm-provider) | Register LM Studio (and other local servers) as a pi provider, discover models | None. You need one of them, or a hand-written provider, for pi to talk to LM Studio at all |
| [chrisetheridge/pi-extension-lmstudio](https://github.com/chrisetheridge/pi-extension-lmstudio), [@monroewilliams/pi-local](https://github.com/monroewilliams/pi-local) | Manual `/load` and `/unload` style commands, multi-backend pickers | Manual only. Nothing happens automatically when you switch models |
| [pi-lm-studio-warm](https://www.npmjs.com/package/pi-lm-studio-warm) | Checks the target model is loaded before every request; evicts least-recently-used models under RAM pressure | Closest relative. It reacts to each request; this extension reacts to the switch and keeps one model by policy. No RAM/VRAM picker |
| LM Studio's own Auto-Evict and idle TTL | One JIT-loaded model at a time, unloaded after idle time | See [above](#why-lm-studios-auto-evict-isnt-enough): JIT-loaded models only, and only once a request arrives |

## See also

- [LM Studio: Idle TTL and Auto-Evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict), the setting this extension fills the gaps of
- [LM Studio: `lms load` and `lms unload`](https://lmstudio.ai/docs/cli/local-models/load), the CLI it drives
- [pi extension docs](https://pi.dev/docs/latest/extensions): the `model_select` event and `before_agent_start` hook it uses

## License

CC0-1.0
