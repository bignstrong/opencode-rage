# Installed-host dictation smoke (macOS, OpenCode 2.4.1 or 2.4.2)

`installed-dictation.py` runs the installed `opencode --standalone` in a PTY. The plugin, Rust addon, Rust recorder core, GigaAM inference, and composer are real. Only the FFmpeg microphone process is a fixture: it advertises one device, writes the synthetic WAV’s PCM, and exits on the recorder’s `q` command.

## Run offline

Prerequisites: an installed OpenCode **2.4.1 or 2.4.2** executable outside your home directory, macOS command-line tools, Rust/Cargo in `/opt/homebrew/bin`, Node/npm, the checkout’s installed `node_modules`, both native crates’ locked dependencies in the local Cargo cache, and Python 3.12+ with `pyte`. Supply a macOS `opencode-voice-transcribe` executable and the catalog’s `gigaam-v3-e2e-ctc-Q4_K_M.gguf`. The script verifies the actual model SHA256 before recording its readiness receipt. It does not download dependencies, models, engines, or voices.

Use a short **synthetic**, mono, 16 kHz, PCM16 Russian WAV, with at least three recognizable words. For example, to make one with an **already installed** Russian voice:

```sh
say -v Milena -o speech.aiff 'Сегодня мы проверяем голосовой ввод. Открой настройки проекта.'
afconvert -f WAVE -d LEI16@16000 -c 1 speech.aiff input.wav
```

From the repository root:

```sh
python3 rust/qa/installed-dictation.py \
  --engine /path/to/opencode-voice-transcribe \
  --model /path/to/gigaam-v3-e2e-ctc-Q4_K_M.gguf \
  --wav /path/to/input.wav \
  --training --keep
```

## What constitutes a pass

- Build both native crates in a scratch copy. Run `npm pack --offline --ignore-scripts`; load the extracted archive with a private copy of installed dependencies. Prepack CI and registry installation are outside this smoke.
- Run the host with a fresh HOME, XDG directories, workspace, and standalone server. The macOS sandbox denies microphone access, non-loopback outbound connections, clipboard helpers, and user-home writes. Inference and the TUI also cannot read the source checkout or real user home.
- Decode the source WAV separately to obtain the expected transcript. In the real TUI, type `Draft: `, click the record button, wait for the stop button, and press Enter. The fixture checks its parent executable is the **packed** `rage-core`, and logs one start and one graceful stop.
- Configure a dictionary entry for the first two recognized words. Read the composer from the rendered terminal, type ` [editable]`, then verify prefix + corrected transcript + suffix, including soft wraps. The transcript is never typed into the PTY. Verify zero loopback provider POSTs, zero SQLite session messages, and no leftover temporary takes.
- With `--training`, configure the plugin's `trainingDir`. Verify one private WAV with the original ASR transcript and no confirmed label.

Exit `0` means all checks passed. `--keep` retains `result.json` (hashes, transcript, counts), `capture.jsonl`, the `before`, `recording`, `inserted`, and `edited` screen snapshots, the archive, and isolated host logs. Without it a successful run removes its scratch directory. On failure the script exits nonzero and prints the evidence directory.

To check recovery on the **same installed package**, pass that retained directory to `python3 rust/qa/failure-host.py /path/to/rage-installed-run --keep`. It rejects a prompt before admission and tests removal of the plugin while a decoder result is pending. Both scenarios use a scratch configuration.

## Hands-free input

```sh
npm run build:native
uv run --with pyte python rust/qa/wake-host.py /path/to/rage-installed-run --keep
```

The fixture synthesizes «Рейдж открой настройки» as one utterance using the installed Milena voice. No artificial pause separates the words. The test packs the plugin, opens a real isolated OpenCode session and enables `/rage-listen`. Two commands must produce exactly `открой настройки` twice in the editable draft, with auto-submit enabled and no messages. Two more sessions exercise navigation and host exit **while the word-heard indicator is visible**. The sandbox denies microphone access and outbound non-loopback connections.

`result.json` reports two independent timing intervals per turn. The name-end reference is the synthesizer’s marker for the next word; the command-end reference is the last 10 ms window above −50 dBFS. The bounds account for the difference between pressing Enter and observing the first ready frame. A negative value means the indicator was observed before the reference, not that decoding took negative time. Replaying WAV measures listener overhead without device capture.

### Wake auto-send acceptance

After building the native binaries, run with Python and `pyte` already installed (or cached by `uv`):

```sh
uv run --offline --no-project --with pyte python rust/qa/wake-auto-host.py /path/to/rage-installed-run --keep
```

Requires macOS with Milena, Swift and `afconvert`, OpenCode 2.4.1, Node/npm, installed `node_modules`, and a retained `installed-dictation.py --keep` run with the verified engine and model. No downloads are needed. The test replays two distinct synthetic wake commands («открой настройки» then «открой календарь») through the packed plugin. `/rage-listen` inserts both in an editable draft with zero requests or messages. `/rage-auto` must send each turn once to a single scratch chat. The only allowed model provider serves canned responses on `127.0.0.1`. The sandbox allows loopback for the private OpenCode API and fixture provider, but denies non-loopback outbound IP traffic, microphone and real-home access. The test checks both provider request histories, the exact stored prompts and replies, and an empty inbox. `--keep` retains the request bodies, PTY snapshots and `result.json`.

To test a second synthesized voice, supply a local [Piper Russian model](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU/denis/medium) and its adjacent `.onnx.json`:

```sh
uv run --no-project --python 3.11 --with piper-tts python rust/qa/wake-corpus-profile.py /path/to/ru_RU-denis-medium.onnx --split test
```

This compares the built-in detector, six personal examples, and the same examples with two negative words. It reports misses, false activations, counts and total audio duration. It plays no audio and opens no microphone. See [detector measurements](../../native/wake-assets/README.md) for the optional Rustpotter comparison.

For **capture-path overhead** and loss of a pinned device, run:

```sh
python3 rust/qa/wake-corpus.py dev
python3 rust/qa/wake-idle.py --ffmpeg /absolute/path/to/ffmpeg --seconds 15 \
  --unplug-wav 'native/target/wake-corpus/Milena-160-Рейдж.wav'
```

FFmpeg generates paced 48 kHz pink noise and converts it to the listener’s 16 kHz PCM stream. Inventory is simulated, including replacement of the selected UID after a wake. This measures the cost of real FFmpeg and the Rust listener without opening an audio device; AVFoundation and iPhone transport are outside the measurement.
