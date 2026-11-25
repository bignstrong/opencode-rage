# Rage for OpenCode

One terminal plugin for local dictation, prompt controls, and animated activity indicators. Dictate into a draft, edit it, and send it with the same attachments. Choose the animation independently with `/orbs`.

[Русская инструкция](docs/README.ru.md) · [Development](CONTRIBUTING.md) · [License](LICENSE)

## Install from this repository (OpenCode V2)

On macOS this branch uses Rust by default. Source builds require Cargo and Xcode Command Line Tools. The npm tarball built on a Mac includes the core executable and the native addon for that Mac's architecture.

```sh
git clone https://github.com/bignstrong/opencode-rage.git
cd opencode-rage
npm ci
npm run build:native
pwd
```

**Upgrading from `opencode-voice` on macOS?** Quit OpenCode before it loads Rage for the first time. From the built Rage directory, run:

```sh
./native/target/release/rage-core migrate-settings "${XDG_STATE_HOME:-$HOME/.local/state}/opencode/latest/tui"
```

This is the standard OpenCode 2.4.1 `latest` channel path. For a different profile, run `opencode debug paths` in its environment and pass the absolute physical directory containing `plugin.opencode-voice.settings.json`. The command copies that file to `plugin.rage.settings.json` with owner-only permissions. It keeps the original, never replaces an existing destination, and does nothing if the old settings are absent. It prints only the outcome. Models and engines stay in their existing cache.

In `~/.config/opencode/cli.json`, add the absolute path printed by `pwd` to `plugins`. If you used `opencode-voice`, **replace** its entry with that path. Start OpenCode, or run `/reload` for a fresh install in an open TUI. This checkout does not require an npm release.

```json
{"plugins": ["/absolute/path/to/rage"]}
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

Run `node bin/opencode-voice.js doctor` for recorder and engine diagnostics. The V1 entry remains in `index.js`; V2 loads `src/tui.ts`. Both share `lib/`. Run `npm run check` before changing the plugin.

## Credits

Rage is based on [safwan-o/opencode-voice](https://github.com/safwan-o/opencode-voice), derived from [ihxnnxs/opencode-voice](https://github.com/ihxnnxs/opencode-voice). The original MIT [license](LICENSE) is retained. Upstream credits:

- OpenCode wordmark SVG adapted from the public [OpenCode repository](https://github.com/anomalyco/opencode). The `voice` mark was added for this plugin.
- [Handy](https://github.com/cjpais/Handy) inspired the local-first model experience and supplies the curated `transcribe.cpp` model catalog this plugin pins and verifies.
- Local Whisper transcription uses [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp).
- Handy GGUF transcription runs through the Rust [`transcribe-cpp`](https://crates.io/crates/transcribe-cpp) binding and its upstream `transcribe.cpp` runtime.
- Recording and conversion rely on [FFmpeg](https://ffmpeg.org/) where the platform recorder requires it; managed distribution uses [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static).
- Model artifacts are hosted by [Hugging Face](https://huggingface.co/). Individual model creators and licenses remain those declared by each upstream model repository; their pinned source URLs are retained in `lib/handy-model-catalog.js`.
