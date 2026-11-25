# Mac V2 cutover ledger

**Rust is the Mac V2 default.** OpenCode **2.4.1** loads `./tui` (`src/tui.ts`); with no injected runtime and `RAGE_RUST` unset it selects `NativeRuntime`. `RAGE_RUST=0` selects the JS reference. Baseline: `abf76dc`. Audit machine: Apple Silicon. V1, `rage/tui.ts`, and the stand-alone Rust CLI are not substitutes for this entry point.

## Findings that affect the cutover

1. **Home dictation and session controls passed on the same installed archive**, SHA256 `7261b48d257748dd3b3c305dfd460d198516479d27b2b9a510a9929e7f679ede`. The home receipt records a UID-pinned synthetic recorder, real Russian GigaAM inference, editable draft, zero provider POSTs and zero stored messages. That run pre-seeded onboarding, engine and model receipt; cleanup and auto-submit were off. Final default `npm run check`: **199 passed, 0 failed, 11 skipped (210 total)**.
2. **Pinned-open recovery is fixed.** A device that enumerates successfully but fails to open used to yield a generic toast. The script now injects that exact FFmpeg failure before the first sample. Freshly built Rust and archived JS both attempted capture once and raised `VOICE_MIC_UNAVAILABLE`, the code that opens the replacement-input dialog. Neither fell back to another microphone.
3. **Release packaging builds before packing.** `.github/workflows/publish-npm.yml` builds both macOS targets, merges and signs addon/core, packs once on `macos-15`, and checks each architecture separately in both extracted binaries. The publish job consumes that tarball by digest. Offline verification loaded the extracted arm64 addon, ran the core's `cli --help`, found the generated JS and verified both signatures. `--release-inputs` exited **2**: the Intel target is not installed here. The universal release artifact and native Intel execution remain unverified by this audit.

## What runs on the default path

| User action | Rust owns | JS/TS still matters in production |
| --- | --- | --- |
| Start, stop, cancel, decode | `Session.prepareStep` orders engine, uncached model, then recorder; `Session` owns cancellation, phase and send eligibility. `native/host/src/decode.rs` validates decode inputs and chooses language, timeout, filter and WAV recovery policy. Core verifies the recorder and invokes the decoder. | `rust-controller.js` snapshots settings/destination and executes requested readiness effects, toasts and recovery. `NativeRuntime` resolves the executable, applies the decode plan and tracks files/jobs; `rage/core.ts` manages process groups, deadlines, protocol and cleanup. |
| Edit, review, send | `Drafts`, `deliveryAction`, `commandRows` and `footerView`. | `src/tui.ts` tracks footer/session/focus, locates the editor by render-tree ancestry, inserts text, dispatches `prompt.submit`, calls `session.prompt` and requeues after failure. Selection, attachments, slot lifetimes and cursor semantics depend on the host. |
| Choose mic, configure, migrate | Picker reducer, menu views/selection effects, preference normalization/migrations, recorder lookup and catalog/inventory. | `mic-picker.ts` schedules scans, forwards mouse/key events and disposes the dialog. `dialogs.ts` performs SDK navigation, effects and writes; `ctx.storage.store` persists them. `lib/models.js` still checks the JS Handy catalog at import and has JS fallbacks for mutated catalogs, patched FS or unsupported inputs. Injected `createRuntime` bypasses native audio, not all native policy. |
| Acquire models/engines; display progress | Core install/verify/resume; addon readiness policy and progress formatting (`native/host/src/readiness.rs`, `lib.rs`). | `src/ensure.ts` owns shared in-flight promises/listeners/timers; `lib/rust-assets.js` spawns core, bridges injected fetch by Unix socket, and relays events. The host holds per-model status and clears it. First-run download, failure and retry remain user-visible integration points. |
| Animate and control footer | `Orb` generates and crops spinner frames; the native footer selects labels and glyphs. `activateKey` and `releaseButton` decide which events activate a button and consume duplicate clicks. | `button/controls.ts` tracks focus, press state and event timing; `dock.ts` and `agent-activity.ts` attach to and restore 2.4.1 host renderables. |

The audit checks the **unset** environment explicitly as well as the two replay modes. Selecting `NativeRuntime` alone does not establish independence from legacy modules. Equally, importing `lib/engine.js` does not mean that its JS `VoiceRuntime` recorded the audio.

## Evidence and remaining acceptance work

- **Offline rerun: exit 0.** Typecheck passed; 82 Node tests and 7 Bun/OpenTUI tests passed **per mode**, no skips in those lanes. 21 core unit tests, 2 compiled capture/inference tests; 1 real-ASR unit ignored, 15 install tests filtered to avoid IP fixtures. `runtime-packed.mjs` passed 7 JS and 8 Rust package-consumer tests (synthetic Whisper/sidecar, caller files, timeout/cancel/reuse, native SoX).
- **Oracle quality:** 1,088 Rust catalog/preference comparisons and 910 public-export comparisons against an archived baseline; 36 CLI cases matched. Retained JS references matched 3,624 picker transitions, 134 EN/RU dialog traces, and 9,216 animation frames. Layout comparison matched 162 dock observations. Historical formatter gate: 125/125 cases, 0.21× scalar JS throughput; not integrated latency.
- **Readiness gate:** 42/42 traces matched `abf76dc` (334 results, calls and status events). Only Darwin traces require a native readiness call; observable effects are compared in every trace.
- **Interrupted session and normal-stop control:** on the home archive above, two synthetic disconnects with auto-submit enabled produced drafts at the origin, including after a session switch. Zero provider POSTs and zero stored messages. Normal stop produced one POST and one user/assistant pair in the origin.
- **Native button guards:** the packed build `714e7494a374d80d44ff8a4a28cbb2c0dbad287a2aa136246c68cee3c0ddefce` produced the same editable home transcript after two real footer clicks. No messages or provider POSTs. OpenTUI input tests separately cover keyboard focus, modifiers, drag and double-click suppression.
- **Explicit settings migration and installed restart:** the helper was tested with 16 concurrent calls (migration worker). The installed restart receipt on a separate candidate records two launches retaining `alt+r`, missing pinned mic, custom cache, selected model, languages and auto-submit off. Four inventory calls, zero captures. Existing settings survived repeated migration; legacy bytes remained unchanged. Without the explicit helper, the old-only control still showed onboarding.
- **Cold acquisition and warm reuse:** `qa/cold-assets.mjs` passed against the exact home/session tarball above. Packed `src/ensure.ts`, addon and core used a fresh private cache, trusted local registry, unmodified fetch path and loopback HTTP. For both model and engine: first call rejected a same-size SHA256 mismatch without publishing; second call retried corrupt bytes and accepted good bytes on attempt 2/2. Installed model bytes, model receipt, managed executable bytes and manifest digest checked. Three GETs per asset, zero during warm reuse with the registry removed. The weights and probe executable are synthetic. `test/engine-install-security.test.js` separately covers pinned remote registry and post-decompression hash failures.
- **Failed submit and unload mid-decode:** `qa/failure-host.py` passed on the `714e7494…` archive. A server hook refused admission before a provider request; the recognized text replaced only the selected word. A manual retry preserved the attachment URI and mention range. Unloading Rage while a real decode result was held stopped both processes, cleaned the WAV and temporary directory, and left the original draft editable. No late insertion or send occurred.
- **Rendered first-run progress/error/retry:** `qa/cold-ui.py` passed on the `714e7494…` archive in OpenCode 2.4.1 with a fresh profile. The terminal showed engine retry `2/2`, model progress `50%`, automatic retry, SHA256 failure, and `Dictation ready` after retrying from settings. Two engine GETs and three model GETs stayed on loopback; the final model matched its catalog digest. The public registry was not contacted.
- **Real Whisper with cleanup requested:** `RAGE_QA_CLEANUP=1 node rust/qa/compare-inference.mjs synthetic.wav whisper-turbo-q5_0` returned identical nonempty Russian text in eight alternating runs of the public API. This compares the output on one synthetic sample, not microphone quality.
- **Hardware/visual limits:** fixtures do not reproduce TCC denial/regrant, real AVFoundation variants or Continuity reconnect timing. Real Whisper output with cleanup enabled, keyboard-only activation, theme changes and indicator restoration on plugin unload remain outside the home smoke. `qa/installed-layout.py` separately exercises the running spinner at 100/72/44 columns and return to idle. No live microphone needed for the other gates.

## Repeat

`rust/qa/fixtures/voice-reference.tar.gz` contains the MIT-licensed reference sources used for differential tests (`abf76dc`), not a Git repository. The checks work from a fresh clone with only the initial commit.

```sh
# Offline build, pack, extract, inspect signatures and verify both slices.
bash scripts/check-rust.sh --release-inputs
# Or verify an existing trusted release tarball on disk, without rebuilding it.
bash scripts/check-rust.sh --release-inputs "$RELEASE_ARCHIVE"
# Packed readiness flow, loopback only, fresh private cache; Node 24+ on macOS.
rust/qa/cold-assets.mjs "$RELEASE_ARCHIVE"

# Scratch build + fixtures, with a preinstalled Bun, Node/npm, node_modules and Cargo registry.
bash scripts/check-rust.sh  # Bun on PATH, or set BUN to its executable
```

The script blocks IP sockets and microphone access, uses private HOME/temp directories and does not publish. Release mode exits 2 if offline targets are missing and only a host build could be verified; exit 0 requires universal slices. The installed PTY procedure is separate: see [qa/README.md](qa/README.md). It requires an explicitly supplied model, engine, synthetic WAV and a loopback-only provider.
