"""macOS: python session-interrupted.py /path/to/successful/rage-installed-... [--keep].

Uses the packed offline assets from installed-dictation.py. Requires Python with pyte.
All host state, capture signals and terminal snapshots belong to this run.
"""
import argparse
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tarfile
import tempfile
import termios
import time

import pyte

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("installed", HERE / "installed-dictation.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
check, dump, sha = smoke.check, smoke.dump, smoke.sha


@contextlib.contextmanager
def terminal(argv, project, env):
    pid, fd = pty.fork()
    if not pid:
        try:
            os.chdir(project)
            os.execve(argv[0], argv, env)
        finally:
            os._exit(127)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))
        yield fd
    finally:
        os.close(fd)
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
        until = time.monotonic() + 4
        while not os.waitpid(pid, os.WNOHANG)[0]:
            if time.monotonic() > until:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                break
            time.sleep(.05)


def run_test(root, assets):
    receipt = json.loads((assets / "result.json").read_text())
    archive, = assets.glob("*.tgz")
    check(sha(archive) == receipt["archiveSHA256"], "packed archive changed")
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter="data")
    pkg = root / "package"
    shutil.copytree(assets / "package/node_modules", pkg / "node_modules", symlinks=True)
    for name, digest in [("input.wav", "wavSHA256"), ("opencode-voice-transcribe", "engineSHA256")]:
        shutil.copy2(assets / name, root / name)
        check(sha(root / name) == receipt[digest], f"{name} changed")
    core = pkg / "native/target/release/rage-core"
    check(sha(core) == receipt["coreSHA256"], "unexpected packed core")
    voice = root / "voice"
    models = voice / "models"
    models.mkdir(parents=True)
    model = models / smoke.MODEL
    shutil.copyfile(assets / "voice/models" / smoke.MODEL, model)
    check(sha(model) == smoke.DIGEST, "unexpected GigaAM weights")
    s = model.stat()
    model.with_suffix(".gguf.sha256").write_text(
        f"{smoke.DIGEST} {s.st_dev}:{s.st_ino}:{s.st_size}:{s.st_mtime_ns}:{s.st_ctime_ns}")
    recorder = root / "ffmpeg"
    recorder.write_text("#!/usr/bin/python3\n" + (HERE / "session-recorder.py").read_text())
    recorder.chmod(0o700)
    home, tmp, project = [root / x for x in ("home", "tmp", "project")]
    for path in (home, tmp, project):
        path.mkdir()
    env = dict(HOME=str(home), TMPDIR=f"{tmp}/", TERM="xterm-256color", COLORTERM="truecolor",
               LANG="en_US.UTF-8", PATH=f"{root}:/opt/homebrew/bin:/usr/bin:/bin", QA_RUN=str(root),
               QA_KEY="offline-fixture", GIT_CONFIG_NOSYSTEM="1", XDG_RUNTIME_DIR=str(tmp),
               RAGE_RUST="1", RAGE_FFMPEG=str(recorder), OPENCODE_VOICE_FFMPEG=str(recorder),
               OPENCODE_VOICE_TRANSCRIBE_CPP=str(root / "opencode-voice-transcribe"),
               OPENCODE_VOICE_DIR=str(voice))
    for key in ("CONFIG", "DATA", "STATE", "CACHE"):
        env[f"XDG_{key}_HOME"] = str(home / key.lower())
    profile = ('(version 1)(allow default)(deny device-microphone)'
               '(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))'
               '(deny process-exec (literal "/usr/bin/pbcopy")(literal "/usr/bin/pbpaste")'
               '(regex #"/(ffmpeg|sox|rec|arecord)$"))'
               f'(allow process-exec (literal {json.dumps(str(recorder))}))'
               f'(deny file-read* file-write* (subpath {json.dumps(str(Path.home().resolve()))}))')
    host = ["/usr/bin/sandbox-exec", "-p", profile, str(Path(shutil.which("opencode")).resolve())]

    def cli(*args):
        return subprocess.run([*host, *args], cwd=project, env=env, check=True,
                              timeout=25, capture_output=True, text=True).stdout.strip()

    version = cli("--version")
    check(version.removeprefix("opencode v") == "2.4.1", f"wrong host: {version}")
    expected = receipt["transcript"]
    check(len(expected.split()) >= 3, "missing independent reference transcript")
    with smoke.provider() as (port, posts):
        cfg = home / "config/opencode"
        cfg.mkdir(parents=True, exist_ok=True)
        options = dict(model="handy-gigaam-v3-e2e-ctc-gguf", language="ru", uiLanguage="en",
                       autoSubmit=True, recordingHotkey="alt+r", voiceEnhance=False,
                       voiceAnimation=False, mic=":uid:1:Fixture", downloadDir=str(voice))
        state = home / "state/opencode/latest/tui/plugin.rage.settings.json"
        state.parent.mkdir(parents=True)
        dump(state, {**options, "onboardingDone": True, "hotkeyMigratedV3": True})
        dump(cfg / "cli.json", {"plugins": [{"package": str(pkg), "options": options}],
                                "animations": False, "attention": {"sound": False, "notifications": False}})
        dump(cfg / "opencode.json", {"model": "qa/fixture", "update": "disable", "snapshots": False,
             "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                          {"action": "provider.use", "resource": "qa", "effect": "allow"}],
             "providers": {"qa": {"name": "QA", "env": ["QA_KEY"], "models": {"fixture": {}},
                 "package": "@opencode/ai/providers/openai-compatible",
                 "settings": {"baseURL": f"http://127.0.0.1:{port}/v1"}}}})
        origin, away = ["QA Origin", "QA Away"]
        ids = {title: json.loads(cli("api", "--standalone", "session.create", "-d",
                              json.dumps({"title": title})))["data"]["id"] for title in (origin, away)}
        db = home / "data/opencode/opencode.db"

        def messages():
            with contextlib.closing(sqlite3.connect(f"file:{db}?mode=ro", uri=True)) as conn:
                return conn.execute("SELECT session_id, type FROM session_message").fetchall()

        with terminal([*host, "--standalone", "--session", ids[origin]], project, env) as fd:
            screen = pyte.Screen(150, 40)
            stream = pyte.ByteStream(screen)
            text = lambda: "\n".join(line.rstrip() for line in screen.display)
            composer = lambda: " ".join(" ".join(line[3:108].strip() for line in screen.display[-10:]
                                if line.startswith("  ┃") and "Build ·" not in line).split())

            def wait(label, predicate, timeout=18):
                end = time.monotonic() + timeout
                while not predicate():
                    if time.monotonic() >= end:
                        (root / "last.txt").write_text(text())
                        raise RuntimeError(f"timeout at {label}\n{text()}")
                    if select.select([fd], [], [], .1)[0]:
                        data = os.read(fd, 65536)
                        check(data, f"host exited at {label}")
                        if b"\x1b[6n" in data:
                            os.write(fd, b"\x1b[1;1R")
                        stream.feed(data)
                (root / f"{label}.txt").write_text(text())

            send = lambda keys: os.write(fd, keys.encode())
            at = lambda title: any(line.strip() == title for line in screen.display[:6])

            def switch(title, label):
                send("\x18l")  # 2.4.1 "Switch session" shortcut.
                wait(label+"-list", lambda: "Search sessions in project" in text())
                send(title)
                wait(label+"-filter", lambda: any(line.strip().startswith("┃") and
                     line.strip()[1:].strip() == title for line in screen.display[8:32]))
                send("\r")
                wait(label, lambda: at(title) and "Search sessions" not in text())

            log = root / "capture.jsonl"
            events = lambda: [json.loads(s) for s in log.read_text().splitlines()] if log.exists() else []
            wait("origin", lambda: at(origin) and "●" in text())
            for n, change_route in enumerate((False, True), 1):
                label = f"take{n}"
                send("\x1br")  # voice.record, not the always-review footer button.
                wait(label+"-live", lambda: "■" in text() and events().count("pcm") == n)
                if change_route:
                    switch(away, "away-recording")
                (root / "unplug").touch()
                wait(label+"-interrupted", lambda: "Microphone unavailable" in text() and
                     "Nothing was sent" in text() and "Choose Microphone" in text() and
                     events().count("closed") == n, 45)
                send("\x1b")
                wait(label+"-dismissed", lambda: at(away if change_route else origin) and
                     "Choose Microphone" not in text() and "●" in text())
                if change_route:
                    check(at(away) and expected not in composer(), "draft leaked to other session")
                    switch(origin, "back-at-origin")
                wait(label+"-draft", lambda: at(origin) and composer() == expected)
                send(" [editable]")
                wait(label+"-edited", lambda: expected + " [editable]" in composer())
                check(not posts and not messages(), f"automatic send after {label}: {posts}, {messages()}")
                # Clear the first draft so the second recovery cannot pass on stale text.
                send("\x01\x0b")
                wait(label+"-clear", lambda: not composer())
                (root / "unplug").unlink()
            interrupted = dict(events=events(), providerPOSTs=len(posts), sessionMessages=len(messages()))
            check(interrupted == dict(events=["pcm", "missing", "closed"] * 2,
                                      providerPOSTs=0, sessionMessages=0), f"unexpected results: {interrupted}")
            # Positive control, after the no-send checkpoint: same hotkey, same session, no device loss.
            send("\x1br")
            wait("control-live", lambda: "■" in text() and events().count("pcm") == 3)
            send("\x1br")
            wait("control-sent", lambda: posts and messages() and expected in text(), 45)
            control_rows = messages()
            check(all(sid == ids[origin] for sid, _ in control_rows), "control reached wrong session")
        check(events() == interrupted["events"] + ["pcm", "closed"], "unexpected control events")
        check(not list((voice / "recordings").iterdir()), "leaked recording")
    return dict(host=version, archiveSHA256=receipt["archiveSHA256"], sessions=ids,
                transcript=expected, autoSubmit=True, interrupted=interrupted,
                normalStopControl=dict(providerPOSTs=list(posts), sessionRows=control_rows))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix="rage-session-")).resolve()
    print(f"Evidence: {root}", flush=True)
    result = run_test(root, args.assets.resolve())
    dump(root / "result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.keep:
        shutil.rmtree(root)
