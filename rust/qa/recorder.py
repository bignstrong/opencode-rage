"""FFmpeg stand-in for the installed-host smoke. Never calls AVFoundation."""
import ctypes
import json
import os
import sys
import wave
from pathlib import Path

root = Path(os.environ["QA_RUN"])
args = sys.argv[1:]
buf = ctypes.create_string_buffer(4096)
if not ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidpath(os.getppid(), buf, len(buf)) > 0:
    raise RuntimeError("cannot identify recorder parent")
core = Path(buf.value.decode()).resolve()
if core != root / "package/native/target/release/rage-core":
    raise RuntimeError(f"unexpected recorder parent: {core}")


def event(kind):
    with (root / "capture.jsonl").open("a") as out:
        print(json.dumps({"event": kind, "core": str(core), "argv": args}), file=out)


if "-list_devices" in args:
    event("inventory")
    print("AVFoundation audio devices:\n[0] Fixture  [uid:1]", file=sys.stderr)
    sys.exit(1)  # FFmpeg's device-list command exits nonzero.
if args[-1:] != ["pipe:1"] or "-audio_device_id" not in args or "uid:1" not in args:
    raise RuntimeError(f"unexpected recorder command: {args}")
print("[avfoundation @ 0x1] audio device 'Fixture' opened", file=sys.stderr, flush=True)
with wave.open(str(root / "input.wav")) as src:
    sys.stdout.buffer.write(src.readframes(src.getnframes()))
    sys.stdout.buffer.flush()
event("start")
if sys.stdin.buffer.readline() != b"q\n":
    raise RuntimeError("no graceful stop")
event("stop")
