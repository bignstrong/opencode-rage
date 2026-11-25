"""macOS: python (with pyte) installed-layout.py /path/to/plugin-with-built-addon-and-deps"""
import contextlib
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import threading
import time

import pyte


def run(package, host, work, mode):
    home = work / "home"
    project = work / "project"
    project.mkdir()
    env = dict(HOME=str(home), LANG="en_US.UTF-8", TERM="xterm-256color",
               COLORTERM="truecolor", PATH="/opt/homebrew/bin:/usr/bin:/bin",
               TMPDIR=str(work), RAGE_RUST=mode, QA_KEY="offline-fixture", GIT_CONFIG_NOSYSTEM="1")
    for field in ("CONFIG", "STATE", "CACHE", "DATA", "RUNTIME"):
        path = home / field.lower()
        path.mkdir(parents=True)
        env[f"XDG_{field}_HOME"] = str(path)
    cfg = home / "config/opencode"
    cfg.mkdir()
    settings = dict(onboardingDone=True, setupSkipped=True, voiceAnimation=True,
                    uiLanguage="en", downloadDir=str(work / "assets"))
    state = home / "state/opencode/latest/tui/plugin.rage.settings.json"
    state.parent.mkdir(parents=True)
    state.write_text(json.dumps(settings))
    (cfg / "cli.json").write_text(json.dumps({
        "plugins": [{"package": str(package), "options": settings}],
        "animations": True, "attention": {"sound": False, "notifications": False},
    }))
    release = threading.Event()

    class Provider(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            if request.get("tools"):
                release.wait(20)
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                self.wfile.write(b'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Layout complete"},"finish_reason":null}]}\n\n'
                                 b'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    (cfg / "opencode.json").write_text(json.dumps({
        "model": "qa/fixture", "update": "disable", "snapshots": False,
        "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                     {"action": "provider.use", "resource": "qa", "effect": "allow"}],
        "providers": {"qa": {"env": ["QA_KEY"], "models": {"fixture": {"capabilities": {"toolcall": True}}},
                             "package": "@opencode/ai/providers/openai-compatible",
                             "settings": {"baseURL": f"http://127.0.0.1:{server.server_port}/v1"}}},
    }))
    policy = ('(version 1)(allow default)(deny device-microphone)'
              '(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))'
              '(deny process-exec (regex #"/(ffmpeg|sox|rec|arecord|pbcopy|pbpaste)$"))'
              f'(deny file-write* (subpath {json.dumps(str(Path.home().resolve()))}))')
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(project)
        os.execve("/usr/bin/sandbox-exec", ["sandbox-exec", "-p", policy, host, "--standalone"], env)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    height = 32
    screen = pyte.Screen(100, height)
    stream = pyte.ByteStream(screen)

    def resize(width):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        screen.resize(lines=height, columns=width)

    def wait(label, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                raise RuntimeError(f"{label} timed out\n" + "\n".join(screen.display))
            if select.select([fd], [], [], 0.1)[0]:
                data = os.read(fd, 65536)
                if not data:
                    raise RuntimeError(f"host exited: {label}")
                if b"\x1b[6n" in data:
                    os.write(fd, b"\x1b[1;1R")
                stream.feed(data)

    def buttons():
        return any(re.search(r"↑\s+●", line) for line in screen.display)

    interrupt = re.compile(r"esc (?:interrupt|[.…]+rupt)")

    try:
        resize(100)
        wait("idle footer", buttons)
        assert not any("ctrl+p commands" in line for line in screen.display)
        os.write(fd, b"Layout probe\r")
        for columns, width in [(100, 15), (72, 9), (44, 3)]:
            resize(columns)
            seen = set()

            def animated():
                for line in screen.display:
                    hint = interrupt.search(line)
                    if hint:
                        # At narrow widths the host clips the label and removes the gap.
                        for end in (hint.start(), hint.start() - 1):
                            if end >= width and line[end - width // 2 - 1] in "·•●":
                                seen.add(line[end-width:end])
                return len(seen) >= 2

            wait(f"moving {width}-cell spinner at {columns} columns", animated)
        release.set()
        wait("idle restoration", lambda: buttons() and not any(interrupt.search(line) for line in screen.display))
        print(f"OpenCode 2.4.1 RAGE_RUST={mode}: dock visible, commands hidden, moving frames at 100/72/44 columns, idle restored.")
    finally:
        release.set()
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
        os.close(fd)
        deadline = time.monotonic() + 3
        while not os.waitpid(pid, os.WNOHANG)[0]:
            if time.monotonic() >= deadline:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                break
            time.sleep(0.03)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    package = Path(sys.argv[1]).resolve(strict=True)
    host = shutil.which("opencode")
    if not host or not (package / "native/rage.node").is_file():
        sys.exit("Requires installed OpenCode 2.4.1 and a plugin package with the built layout addon.")
    for mode in ("0", "1"):
        with tempfile.TemporaryDirectory(prefix="rage-layout-") as folder:
            run(package, host, Path(folder), mode)
