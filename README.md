# Rage for OpenCode

A terminal plugin for local dictation, prompt controls, and animated activity indicators. Dictate into a draft, edit it, and send it with the same attachments. Choose the animation independently with `/orbs`.

[Русская инструкция](docs/README.ru.md) · [Development](CONTRIBUTING.md) · [License](LICENSE)

## Install the release (macOS Apple Silicon, OpenCode V2)

Download the `.tgz` and `SHA256SUMS` from [Rage v0.2.0](https://github.com/bignstrong/opencode-rage/releases/tag/v0.2.0). From their directory, run:

```sh
shasum -a 256 -c SHA256SUMS
mkdir -p "$HOME/.local/share/rage/0.2.0"
tar -xzf opencode-rage-v0.2.0-darwin-arm64.tgz -C "$HOME/.local/share/rage/0.2.0"
cd "$HOME/.local/share/rage/0.2.0/package"
npm install --omit=dev
pwd
```

Add the directory printed by `pwd` to the existing `plugins` array in `~/.config/opencode/cli.json`. Run `/reload` in an open TUI.

On first activation Rage sets the global OpenCode theme to **orng**. It preserves light/dark mode and leaves later theme choices alone. New Rage profiles use Russian menus and recognition, Whisper Turbo, the system microphone, and the orange **Digital breath** thinking orb. Dictation stays in the draft. No shortcuts or model downloads are required at startup. Change voice preferences with `/voice-settings` and the animation with `/orbs`; saved preferences take precedence.

## Install from source (OpenCode V2)

On macOS Rage uses its Rust core by default. Source builds require Cargo and Xcode Command Line Tools. The npm tarball built on a Mac includes the core executable and the native addon for that Mac's architecture.

```sh
git clone https://github.com/bignstrong/opencode-rage.git
cd opencode-rage
npm ci
npm run build:native
pwd
```

In `~/.config/opencode/cli.json`, add the absolute path printed by `pwd` to `plugins`. If you used `opencode-voice`, **replace** its entry with that path. Start OpenCode, or run `/reload` for a fresh install in an open TUI. This checkout does not require an npm release.

```json
{"plugins": ["/absolute/path/to/opencode-rage"]}
```

## Commands

| Command | Action |
| --- | --- |
| `/voice` | Start or finish dictation into the draft. |
| `/voice-submit` | Record for submission. An interrupted take stays a draft. |
| `/voice-stop` | Cancel recording or recognition. |
| `/voice-settings` | Choose input, model, language, and recording behavior. |
| `/orbs` | Pick the animation for agent activity and transcription. |

On macOS the microphone list updates while open. Choose the system input or pin a microphone by name. An iPhone exposed by Continuity works the same way: start recording on the Mac, speak into the phone.

Run `./bin/rage doctor` for recorder and engine diagnostics. On macOS the CLI runs the Rust executable directly, without starting Node. On Windows use the portable `opencode-voice` command. OpenCode V2 still loads the TypeScript plugin in `src/tui.ts`. Run `npm run check` before changing the plugin.

## How Rage works

- [`native/src/`](native/src/): the Rust executable discovers microphones, supervises FFmpeg or SoX, recovers interrupted takes, verifies model downloads and runs the selected speech engine. The decoder itself is Whisper or transcribe.cpp.
- [`native/host/src/`](native/host/src/): the Rust addon decides when a take can be sent, tracks pending drafts, handles settings and microphone selection, and generates animation frames.
- [`src/tui.ts`](src/tui.ts): the TypeScript plugin registers commands with OpenCode, renders controls and inserts recognized text into its editor. The legacy entry and reference implementation remain in JavaScript.

[Third-party notices](NOTICE.md) · [Benchmark on Apple Silicon](docs/performance.ru.md)
