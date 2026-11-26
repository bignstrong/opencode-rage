# Setup OpenCode

An OpenCode V2 interface plugin with recording and send buttons, custom themes, and a thinking orb. On macOS, the Rust core records and transcribes speech on your device. Dictate into a draft, edit it, and send it with the same attachments.

[Русская инструкция](docs/README.ru.md) · [Development](CONTRIBUTING.md) · [License](LICENSE)

## Install the previous release (macOS Apple Silicon, OpenCode V2)

Download the `.tgz` and `SHA256SUMS` from [Rage v0.2.0](https://github.com/bignstrong/setup-opencode/releases/tag/v0.2.0). This artifact predates the repository split. For the new layout, install from source below. From the directory with the downloads, run:

```sh
shasum -a 256 -c SHA256SUMS
mkdir -p "$HOME/.local/share/rage/0.2.0"
tar -xzf opencode-rage-v0.2.0-darwin-arm64.tgz -C "$HOME/.local/share/rage/0.2.0"
cd "$HOME/.local/share/rage/0.2.0/package"
npm install --omit=dev
pwd
```

Add the directory printed by `pwd` to the existing `plugins` array in `~/.config/opencode/cli.json`. Run `/reload` in an open TUI.

On first activation the plugin sets the global OpenCode theme to **orng**. It preserves light/dark mode and leaves later theme choices alone. New profiles use Russian menus and recognition, Whisper Turbo, and the system microphone. Orange digital rain shows while speech is being transcribed. The agent defaults to orange **Digital breath**. Dictation stays in the draft. No shortcuts or model downloads are required at startup. Change voice preferences with `/voice-settings` and the agent animation with `/orbs`.

## Install from source (OpenCode V2)

On macOS the plugin uses its Rust core by default. Source builds require Cargo and Xcode Command Line Tools. The npm tarball built on a Mac includes the core executable and the native addon for that Mac's architecture.

```sh
git clone https://github.com/bignstrong/setup-opencode.git
cd setup-opencode
npm ci
npm run build:native
pwd
```

In `~/.config/opencode/cli.json`, add the absolute path printed by `pwd` to `plugins`. If you used `opencode-voice`, **replace** its entry with that path. Start OpenCode, or run `/reload` for a fresh install in an open TUI. This checkout does not require an npm release.

```json
{"plugins": ["/absolute/path/to/setup-opencode"]}
```

## Commands

Click `●` to start recording. Press Enter in the prompt or click `■` to stop and insert the text at the cursor. Once the text appears, press Enter again or click `↑` to send the draft with its attachments.

The thinking orb uses `orng` orange (`#ec5b2b`) independently of the active theme. Select the built-in `orng` theme for matching prompt borders and labels.

| Command | Action |
| --- | --- |
| `/voice` | Start or finish dictation into the draft. |
| `/rage-listen` | Toggle hands-free Russian wake listening on macOS. Say “Рейдж, открой настройки” in one breath. The command goes into the draft, even with auto-submit enabled. |
| `/rage-auto` | Toggle hands-free sending in the current chat. A finished phrase sends after transcription. If you already started typing a draft, dictation appends to it for you to send. |
| `/voice-submit` | Record for submission. An interrupted take stays a draft. |
| `/voice-stop` | Cancel recording or recognition. |
| `/voice-settings` | Choose input, model, language, and recording behavior. |
| `/orbs` | Pick the animation for agent activity and transcription. |

On macOS the microphone list updates while open. Choose the system input or pin a microphone by name. An iPhone exposed by Continuity works the same way: start recording on the Mac, speak into the phone.

For wake listening, choose a **specific microphone** and prepare the recognition model first. Toggling the command off or closing the terminal releases its input.

Wake detection is experimental: held-out speech produced both missed names and false triggers. See the [corpus and detector comparison](native/wake-assets/README.md#offline-measurements).

If the built-in examples miss your voice, launch OpenCode with `RAGE_WAKE_PROFILE="$HOME/rage-examples"`. Supply 3–8 short mono PCM16 WAVs of “Рейдж” at different speeds; trim a couple from fluent sentences. Optional `reject-*.wav` examples of confusables count toward the eight-file limit. At least three examples must be positive. Test on fresh phrases before relying on the profile.

Run `./bin/setup-opencode doctor` for recorder and engine diagnostics. On macOS the CLI runs the Rust executable directly, without starting Node. On Windows use the portable `opencode-voice` command. OpenCode V2 loads the TypeScript plugin in `src/tui.ts`. Run `npm run check` after the native build.

For manual drafts in OpenCode V2, add `"dictationDictionary": {"кубер контрол": "kubectl"}` to the plugin's `options` in `cli.json`. Matching ignores case and requires whole words. The longest phrase wins at the same position. Replacements apply only to newly inserted dictation.

On macOS, set `RAGE_TRAINING_DIR` or the plugin option `trainingDir` to an absolute path accessible only to your account (mode `0700`) to build a private training set. Rage keeps completed dictations, wake commands and calibration takes. It excludes waiting audio and captures cancelled before the command ends. Collection is off by default; set `RAGE_SAVE_TAKES=0` to pause it. Training samples keep the raw ASR result before dictionary replacements. From this checkout, run `python3 scripts/training_data.py review "$RAGE_TRAINING_DIR"` to listen and correct transcripts; `manifest` exports only confirmed labels.

## How the plugin works

- [`native/src/`](native/src/): the Rust executable discovers microphones, supervises FFmpeg or SoX, recovers interrupted takes, verifies model downloads and runs the selected speech engine. The decoder itself is Whisper or transcribe.cpp.
- [`native/host/src/`](native/host/src/): the Rust addon decides when a take can be sent, tracks pending drafts, handles settings and microphone selection, and generates animation frames.
- [`src/tui.ts`](src/tui.ts): the TypeScript plugin registers commands with OpenCode, renders controls and inserts recognized text into its editor. The legacy entry and reference implementation remain in JavaScript.

[Third-party notices](NOTICE.md) · [Benchmark on Apple Silicon](docs/performance.ru.md)
