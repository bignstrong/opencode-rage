"""Gate the real decoder's output so host unload can be observed without a timing race."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(os.environ["QA_RUN"])
engine = str(root / "fixture-asr")
if "--file" not in sys.argv or not (root / "gate").exists():
    os.execv(engine, [engine, *sys.argv[1:]])
result = subprocess.run([engine, *sys.argv[1:]], check=True, stdout=subprocess.PIPE)
marker = root / "decoded.tmp"
marker.write_text(json.dumps({"enginePID": os.getpid(), "corePID": os.getppid(),
                             "tmp": os.environ["TMPDIR"], "text": result.stdout.decode().strip()}))
marker.rename(root / "decoded.json")
for _ in range(600):
    if (root / "release").exists():
        (root / "emitted").touch()
        sys.stdout.buffer.write(result.stdout)
        break
    time.sleep(.1)
else:
    raise RuntimeError("QA decoder gate expired")
