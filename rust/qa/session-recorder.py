"""Fake AVFoundation device. Removing its UID exercises the native inventory watcher."""
import ctypes
import json
import os
from pathlib import Path
import select
import sys
import wave

root = Path(os.environ["QA_RUN"])
buf = ctypes.create_string_buffer(4096)
assert ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidpath(os.getppid(), buf, len(buf)) > 0
assert Path(buf.value.decode()).resolve() == root / "package/native/target/release/rage-core"


def event(kind):
    with (root / "capture.jsonl").open("a") as log:
        print(json.dumps(kind), file=log)


if "-list_devices" in sys.argv:
    print("AVFoundation audio devices:", file=sys.stderr)
    if not (root / "unplug").exists():
        print("[0] Fixture  [uid:1]", file=sys.stderr)
    else:
        event("missing")
    sys.exit(1)

assert sys.argv[-1] == "pipe:1" and "uid:1" in sys.argv
print("[avfoundation @ 0x1] audio device 'Fixture' opened", file=sys.stderr, flush=True)
with wave.open(str(root / "input.wav")) as src:
    sys.stdout.buffer.write(src.readframes(src.getnframes()))
sys.stdout.buffer.flush()
event("pcm")
while not select.select([sys.stdin], [], [], 0.1)[0]:
    # Keep capture live while the operator changes route; no stall-based interruption.
    sys.stdout.buffer.write(bytes(3200))
    sys.stdout.buffer.flush()
assert sys.stdin.buffer.readline() == b"q\n"
event("closed")
