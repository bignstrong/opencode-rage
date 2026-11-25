# Installed-host dictation smoke (macOS, OpenCode 2.4.1)

`installed-dictation.py` runs the installed `opencode --standalone` in a PTY. The plugin, Rust addon, Rust recorder core, GigaAM inference, and composer are real. Only the FFmpeg microphone process is a fixture: it advertises one device, writes the synthetic WAV’s PCM, and exits on the recorder’s `q` command.

## Run offline

Prerequisites: an installed OpenCode **2.4.1** executable outside your home directory, macOS command-line tools, Rust/Cargo in `/opt/homebrew/bin`, Node/npm, the checkout’s installed `node_modules`, both native crates’ locked dependencies in the local Cargo cache, and Python 3.12+ with `pyte`. Supply a macOS `opencode-voice-transcribe` executable and the catalog’s `gigaam-v3-e2e-ctc-Q4_K_M.gguf`. The script verifies the actual model SHA256 before recording its readiness receipt. It does not download dependencies, models, engines, or voices.

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
  --keep
```

## What constitutes a pass

- Build both native crates in a scratch copy. Run `npm pack --offline --ignore-scripts`; load the extracted archive with a private copy of installed dependencies. Prepack CI and registry installation are outside this smoke.
- Run the host with a fresh HOME, XDG directories, workspace, and standalone server. The macOS sandbox denies microphone access, non-loopback outbound connections, clipboard helpers, and user-home writes. Inference and the TUI also cannot read the source checkout or real user home.
- Decode the source WAV separately to obtain the expected transcript. In the real TUI, type `Draft: `, click the record button, wait for the stop button, and click it. The fixture checks its parent executable is the **packed** `rage-core`, and logs one start and one graceful stop.
- Read the composer from the rendered terminal, type ` [editable]`, then verify prefix + independent transcript + suffix in that composer, including soft wraps. The transcript is never typed into the PTY. Verify zero loopback provider POSTs, zero SQLite session messages, and no leftover takes.

Exit `0` means all checks passed. `--keep` retains `result.json` (hashes, transcript, counts), `capture.jsonl`, the `before`, `recording`, `inserted`, and `edited` screen snapshots, the archive, and isolated host logs. Without it a successful run removes its scratch directory. On failure the script exits nonzero and prints the evidence directory.

To check recovery on the **same installed package**, pass that retained directory to `python3 rust/qa/failure-host.py /path/to/rage-installed-run --keep`. It rejects a prompt before admission and tests removal of the plugin while a decoder result is pending. Both scenarios use a scratch configuration.
