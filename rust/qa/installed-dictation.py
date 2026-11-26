"""Installed OpenCode 2.4.1, packed plugin, real offline STT, fake microphone. See README.md."""
import argparse
import contextlib
import fcntl
import hashlib
import http.server
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
import threading
import time
import wave

import pyte

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MODEL = "gigaam-v3-e2e-ctc-Q4_K_M.gguf"
DIGEST = "35581e11e048eef785657cff07e5fced794bba6d9c75143257f6452c8aeea655"


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    with path.open("rb") as src:
        return hashlib.file_digest(src, "sha256").hexdigest()


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@contextlib.contextmanager
def provider():
    posts = []

    class Sink(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            posts.append(self.path)
            self.send_error(503, "unexpected model request")

        def log_message(self, *_):
            pass

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Sink) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port, posts
        finally:
            server.shutdown()
            thread.join()


def terminal(cmd, project, env, run, transcript):
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(project)
            os.execve(cmd[0], cmd, env)
        finally:
            os._exit(127)
    width, height = 150, 40
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
    screen = pyte.Screen(width, height)
    stream = pyte.ByteStream(screen)
    text = lambda: "\n".join(line.rstrip() for line in screen.display)

    def composer():
        # 2.4.1 wraps the draft inside its prompt box, even on a wide PTY.
        return " ".join(line.lstrip()[1:].strip() for line in screen.display
                        if line.lstrip().startswith("┃") and line.lstrip()[1:].strip())

    def wait(label, predicate, timeout=25):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                raise RuntimeError(f"timeout: {label}\n{text()}")
            if select.select([fd], [], [], 0.1)[0]:
                data = os.read(fd, 65536)
                check(data, f"host exited at {label}\n{text()}")
                if b"\x1b[6n" in data:
                    os.write(fd, b"\x1b[1;1R")
                stream.feed(data)
        (run / f"{label}.txt").write_text(text())

    def click(glyph):
        for y, line in enumerate(screen.display, 1):
            if glyph in line:
                x = line.rindex(glyph) + 1
                os.write(fd, f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m".encode())
                return
        raise RuntimeError(f"missing button {glyph!r}")

    try:
        wait("home", lambda: "2.4.1" in text() and "●" in text())
        os.write(fd, b"Draft: ")
        wait("before", lambda: "Draft:" in composer())
        click("●")
        wait("recording", lambda: "■" in text() and (run / "capture.jsonl").exists())
        click("■")
        wait("inserted", lambda: f"Draft: {transcript}" in composer(), 50)
        # Only the prefix and suffix are typed into the PTY. A toast cannot pass this check.
        os.write(fd, b" [editable]")
        wait("edited", lambda: f"Draft: {transcript} [editable]" in " ".join(composer().split()))
    finally:
        (run / "last.txt").write_text(text())
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
        os.close(fd)
        deadline = time.monotonic() + 4
        while not os.waitpid(pid, os.WNOHANG)[0]:
            if time.monotonic() >= deadline:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                break
            time.sleep(0.05)


def smoke(run, args):
    home, tmp, project, voice = (run / x for x in ("home", "tmp", "project", "voice"))
    for path in (home, tmp, project, voice):
        path.mkdir()
    env = {"HOME": str(home), "TMPDIR": str(tmp) + "/", "LANG": "en_US.UTF-8",
           "TERM": "xterm-256color", "COLORTERM": "truecolor", "QA_RUN": str(run),
           "PATH": f"{run}:/opt/homebrew/bin:/usr/bin:/bin", "QA_KEY": "offline-fixture",
           "GIT_CONFIG_NOSYSTEM": "1", "XDG_RUNTIME_DIR": str(tmp)}
    for key in ("CONFIG", "DATA", "STATE", "CACHE"):
        path = home / key.lower()
        path.mkdir()
        env[f"XDG_{key}_HOME"] = str(path)
    jail = ["/usr/bin/sandbox-exec", "-p",
            '(version 1)(allow default)(deny device-microphone)(deny network-outbound (remote ip "*:*"))'
            '(allow network-outbound (remote ip "localhost:*"))'
            '(deny process-exec (literal "/usr/bin/pbcopy")(literal "/usr/bin/pbpaste"))'
            f'(deny file-write* (subpath {json.dumps(str(Path.home().resolve()))}))']

    def execute(argv, cwd=project):
        proc = subprocess.run([*jail, *argv], cwd=cwd, env=env, timeout=90,
                              capture_output=True, text=True)
        check(proc.returncode == 0, f"{argv[0]} exited {proc.returncode}: {proc.stderr[-3000:]}")
        return proc.stdout.strip()

    host = str(Path(args.opencode).resolve(strict=True))
    version = execute([host, "--version"])
    check(version.removeprefix("opencode v") == "2.4.1", f"expected OpenCode 2.4.1, got {version!r}")
    # Rebuild from one private source snapshot. Never overwrite the coordinator's artifacts.
    stage = run / "build"
    shutil.copytree(REPO, stage, ignore=shutil.ignore_patterns(".git", "node_modules", "target", "rage.node"))
    (stage / "node_modules").symlink_to(REPO / "node_modules")
    (run / "node").symlink_to(Path(shutil.which("node")).resolve())
    cargo_cache = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry"
    execute(["/bin/cp", "-R", str(cargo_cache), str(home / "registry")])
    (home / ".cargo").mkdir()
    (home / "registry").rename(home / ".cargo/registry")
    env["CARGO_NET_OFFLINE"] = "true"
    execute(["/bin/sh", "scripts/build-native.sh"], cwd=stage)
    pack = json.loads(execute([shutil.which("node"), str(Path(shutil.which("npm")).resolve()),
                               "pack", "--offline", "--ignore-scripts", "--json",
                               "--pack-destination", str(run)], cwd=stage))[0]
    archive = run / pack["filename"]
    with tarfile.open(archive) as tar:
        tar.extractall(run, filter="data")
    pkg = run / "package"
    for f in ("src/tui.ts", "src/native-runtime.ts", "rage/core.ts", "native/rage.node",
              "native/target/release/rage-core"):
        check((pkg / f).is_file(), f"missing from npm pack: {f}")
    execute(["/bin/cp", "-R", str(REPO / "node_modules"), str(pkg / "node_modules")])
    shutil.rmtree(stage)
    # Version, npm and dependency copy need checkout access. The TUI and ASR do not.
    jail = [*jail[:2], jail[2] + f'(deny file-read* (subpath {json.dumps(str(REPO))})'
            f'(subpath {json.dumps(str(Path.home().resolve()))}))'
            '(deny process-exec (regex #"/(ffmpeg|sox|rec|arecord)$"))'
            f'(allow process-exec (literal {json.dumps(str(run / "ffmpeg"))}))']

    models = voice / "models"
    models.mkdir()
    model = models / MODEL
    shutil.copyfile(args.model, model)
    check(sha(model) == DIGEST, "GigaAM model does not match pinned catalog SHA256")
    s = model.stat()
    model.with_suffix(".gguf.sha256").write_text(
        f"{DIGEST} {s.st_dev}:{s.st_ino}:{s.st_size}:{s.st_mtime_ns}:{s.st_ctime_ns}")
    engine = run / "opencode-voice-transcribe"
    shutil.copy2(args.engine, engine)
    wav = run / "input.wav"
    shutil.copyfile(args.wav, wav)
    with wave.open(str(wav)) as src:
        check((src.getframerate(), src.getnchannels(), src.getsampwidth()) == (16000, 1, 2),
              "fixture must be mono 16 kHz PCM16 WAV")
    transcript = execute([str(engine), "--model", str(model), "--file", str(wav), "--language", "ru"])
    check(len(transcript.split()) >= 3 and "\n" not in transcript, f"unexpected reference: {transcript!r}")
    recorder = run / "ffmpeg"
    recorder.write_text("#!/usr/bin/python3\n" + (HERE / "recorder.py").read_text())
    recorder.chmod(0o700)
    env.update(RAGE_FFMPEG=str(recorder), OPENCODE_VOICE_FFMPEG=str(recorder),
               OPENCODE_VOICE_TRANSCRIBE_CPP=str(engine), OPENCODE_VOICE_DIR=str(voice))
    if getattr(args, "training", False):
        env["RAGE_TRAINING_DIR"] = str(run / "training")

    with provider() as (port, posts):
        cfg = home / "config/opencode"
        cfg.mkdir(exist_ok=True)
        options = {"model": "handy-gigaam-v3-e2e-ctc-gguf", "language": "ru", "uiLanguage": "en",
                   "autoSubmit": False, "voiceEnhance": False, "voiceAnimation": False,
                   "mic": ":uid:1:Fixture", "downloadDir": str(voice)}
        state = home / "state/opencode/latest/tui/plugin.rage.settings.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        dump(state, {**options, "onboardingDone": True})
        dump(cfg / "cli.json", {"plugins": [{"package": str(pkg), "options": options}],
                                "mouse": True, "animations": False,
                                "attention": {"sound": False, "notifications": False}})
        dump(cfg / "opencode.json", {"model": "qa/fixture", "update": "disable", "snapshots": False,
             "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                          {"action": "provider.use", "resource": "qa", "effect": "allow"}],
             "providers": {"qa": {"name": "QA", "env": ["QA_KEY"], "models": {"fixture": {}},
                 "package": "@opencode/ai/providers/openai-compatible",
                 "settings": {"baseURL": f"http://127.0.0.1:{port}/v1"}}}})
        terminal([*jail, host, "--standalone"], project, env, run, transcript)
    check(not posts, f"unexpected provider POSTs: {posts}")
    events = [json.loads(s)["event"] for s in (run / "capture.jsonl").read_text().splitlines()]
    check([e for e in events if e != "inventory"] == ["start", "stop"], f"capture events: {events}")
    check(not list((voice / "recordings").iterdir()), "temporary take was not removed")
    if "RAGE_TRAINING_DIR" in env:
        samples = list((run / "training").glob("*/meta.json"))
        check(len(samples) == 1, "one stopped manual dictation must create one dataset example")
        record = json.loads(samples[0].read_text())
        check(record["source"] == "manual" and record["asr_text"] == transcript
              and record["reference_text"] is None, "manual audio/ASR result not paired correctly")
        audio = samples[0].with_name("audio.wav")
        check(audio.stat().st_size > 44 and audio.stat().st_mode & 0o077 == 0, "missing/private WAV")
    db = home / "data/opencode/opencode.db"
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as con:
        messages = con.execute("SELECT COUNT(*) FROM session_message").fetchone()[0]
    check(messages == 0, f"unexpected persisted messages: {messages}")
    return {"host": version, "archiveSHA256": sha(archive), "coreSHA256": sha(pkg / "native/target/release/rage-core"),
            "wavSHA256": sha(wav), "engineSHA256": sha(engine), "transcript": transcript,
            "events": events, "providerPOSTs": len(posts), "sessionMessages": messages}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("model", "engine", "wav"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--opencode", default=shutil.which("opencode"))
    parser.add_argument("--keep", action="store_true", help="retain successful evidence as well as failures")
    parser.add_argument("--training", action="store_true", help="verify opt-in local collection using only the fixture")
    args = parser.parse_args()
    check(sys.platform == "darwin" and args.opencode, "requires installed macOS OpenCode")
    os.umask(0o077)
    run = Path(tempfile.mkdtemp(prefix="rage-installed-", dir=tempfile.gettempdir())).resolve()
    print(f"Evidence: {run}", flush=True)
    result = smoke(run, args)
    dump(run / "result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.keep:
        shutil.rmtree(run)
