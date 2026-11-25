"""Offline macOS PTY regression. Run with Python 3.12+ and pyte:
python rust/qa/settings-restart.py /path/to/successful/rage-installed-fixture /path/to/old/opencode-voice
Builds the candidate offline in scratch; uses the old Git revision and a fixture model/engine.
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
import struct
import subprocess
import sys
import tarfile
import tempfile
import termios
import time

import pyte

sys.dont_write_bytecode = True
here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("installed", here / "installed-dictation.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
setup_title = "Set up voice input: choose a local model"


@contextlib.contextmanager
def screen_session(root, label, cmd, env):
    pid, fd = pty.fork()
    if not pid:
        try:
            os.chdir(root / "project")
            os.execve(cmd[0], cmd, env)
        finally:
            os._exit(127)
    screen = pyte.Screen(150, 40)
    stream = pyte.ByteStream(screen)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))
    text = lambda: "\n".join(row.rstrip() for row in screen.display)

    def wait(name, predicate):
        deadline = time.monotonic() + 15
        while not predicate(text()):
            if time.monotonic() >= deadline:
                raise RuntimeError(f"{label}/{name}\n{text()}")
            if select.select([fd], [], [], .08)[0]:
                b = os.read(fd, 65536)
                qa.check(b, f"host exited at {label}/{name}")
                if b"\x1b[6n" in b:
                    os.write(fd, b"\x1b[1;1R")
                stream.feed(b)
        (root / f"{label}-{name}.txt").write_text(text())

    try:
        yield lambda s: os.write(fd, s.encode()), wait
    finally:
        (root / f"{label}-last.txt").write_text(text())
        os.close(fd)
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 3
        while not os.waitpid(pid, os.WNOHANG)[0]:
            if time.monotonic() > deadline:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                break
            time.sleep(.04)


def run(root, assets, previous, rev):
    repo = here.parents[1]
    (root / "project").mkdir()
    stage = root / "build"
    shutil.copytree(repo, stage, ignore=shutil.ignore_patterns(".git", "node_modules", "target", "rage.node"))
    (stage / "node_modules").symlink_to(repo / "node_modules")
    subprocess.run(["npm", "run", "build:native"], cwd=stage,
                   env={**os.environ, "CARGO_NET_OFFLINE": "true"}, check=True)
    pack = json.loads(subprocess.check_output([
        "npm", "pack", "--offline", "--ignore-scripts", "--json", "--cache", str(root/"npm-cache"),
        "--pack-destination", str(root)], cwd=stage))[0]
    archive = root / pack["filename"]
    candidate, old = root / "package", root / "prior"
    old.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter="data")
    previous_sha = subprocess.check_output(["git", "-C", previous, "rev-parse", rev], text=True).strip()
    with tempfile.TemporaryFile() as snapshot:
        subprocess.run(["git", "-C", previous, "archive", previous_sha], stdout=snapshot, check=True)
        snapshot.seek(0)
        with tarfile.open(fileobj=snapshot) as tar:
            tar.extractall(old, filter="data")
    for pkg in (candidate, old):
        subprocess.run(["/bin/cp", "-cR", repo/"node_modules", pkg/"node_modules"], check=True)
    # Only the saved downloadDir points here; neither CLI options nor environment supply a cache path.
    cache = root / "custom cache"
    models = cache / "models"
    models.mkdir(parents=True)
    model = models / qa.MODEL
    subprocess.run(["/bin/cp", "-c", assets/"voice/models"/qa.MODEL, model], check=True)
    qa.check(qa.sha(model) == qa.DIGEST, "wrong model")
    engine = root / "opencode-voice-transcribe"
    shutil.copy2(assets / engine.name, engine)
    receipt = json.loads((assets/"result.json").read_text())
    qa.check(qa.sha(engine) == receipt["engineSHA256"], "wrong engine")
    ffmpeg = root / "inventory-fixture"
    ffmpeg.write_text('#!/bin/sh\ncase " $* " in *" -list_devices "*) echo inventory >> "$QA_LOG"; '
                      "printf 'AVFoundation audio devices:\\n[0] Desk  [uid:fixture]\\n' >&2;; "
                      '*) echo UNEXPECTED_CAPTURE >> "$QA_LOG";; esac\nexit 1\n')
    ffmpeg.chmod(0o700)
    expected = dict(recordingHotkey="alt+r", mic=":uid:offline:Absent iPhone",
                    downloadDir=str(cache), model="handy-gigaam-v3-e2e-ctc-gguf", language="ru",
                    uiLanguage="en", autoSubmit=False)
    profile = ('(version 1)(allow default)(deny device-microphone)(deny network-outbound (remote ip "*:*"))'
               '(allow network-outbound (remote ip "localhost:*"))'
               '(deny process-exec (regex #"/(ffmpeg|sox|rec|arecord|pbcopy|pbpaste)$"))'
               f'(deny file-read* file-write* (subpath {json.dumps(str(Path.home().resolve()))}))')
    cmd = ["/usr/bin/sandbox-exec", "-p", profile, str(Path(shutil.which("opencode")).resolve())]

    def install(name, pkg, options=None):
        home = root / name
        env = dict(HOME=str(home), TMPDIR=str(root), LANG="en_US.UTF-8", TERM="xterm-256color",
                   COLORTERM="truecolor", PATH="/opt/homebrew/bin:/usr/bin:/bin", RAGE_RUST="1",
                   QA_LOG=str(root/"inventory.log"), GIT_CONFIG_NOSYSTEM="1", RAGE_FFMPEG=str(ffmpeg),
                   OPENCODE_VOICE_FFMPEG=str(ffmpeg), OPENCODE_VOICE_TRANSCRIBE_CPP=str(engine))
        for key in ("CONFIG", "STATE", "DATA", "CACHE", "RUNTIME"):
            p = home/key.lower()
            p.mkdir(parents=True, exist_ok=True)
            env[f"XDG_{key}_HOME" if key != "RUNTIME" else "XDG_RUNTIME_DIR"] = str(p)
        cfg = home/"config/opencode"
        cfg.mkdir(exist_ok=True)
        qa.dump(cfg/"cli.json", {"plugins": [dict(package=str(pkg), options=options or {})],
                                "animations": False, "attention": {"notifications": False, "sound": False}})
        qa.dump(cfg/"opencode.json", {"update": "disable", "snapshots": False,
                "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"}]})
        return env

    def state(env, plugin):
        return Path(env["XDG_STATE_HOME"])/"opencode/latest/tui"/f"plugin.{plugin}.settings.json"

    def migrate(env, expected_status):
        core = candidate/"native/target/release/rage-core"
        result = subprocess.run([*cmd[:-1], core, "migrate-settings", state(env, "rage").parent],
                                cwd=candidate, env=env, text=True, capture_output=True, check=True)
        qa.check(not result.stderr and json.loads(result.stdout) == expected_status, "unexpected migration result")

    def terminal(label, env):
        return screen_session(root, label, [*cmd, "--standalone"], env)

    def skip(send, wait, store):
        wait("setup", lambda t: setup_title in t)
        send("Skip setup for now")
        wait("filtered", lambda t: "Skip setup for now" in t and "Whisper Small" not in t)
        send("\r")
        wait("skipped", lambda t: setup_title not in t and store.is_file() and
             json.loads(store.read_text()).get("setupSkipped") is True)

    def effective(label, env):
        log = root/"inventory.log"
        before = log.stat().st_size if log.exists() else 0
        with terminal(label, env) as (send, wait):
            wait("home", lambda t: "2.4.1" in t and "●" in t and setup_title not in t)
            send("\x1br")  # actual configured Alt+R, not /voice or the record button
            wait("unavailable", lambda t: "Microphone unavailable" in t and "Recording did not start" in t)
            qa.check(log.stat().st_size > before, "record shortcut did not enumerate the fixture")
            qa.check((cache/"recordings").is_dir() and not list((cache/"recordings").iterdir()),
                     "saved cache was not used or a take was created")
            send("\x1b")
            wait("dismissed", lambda t: "Microphone unavailable" not in t and "●" in t)
            send("/voice-settings")
            wait("slash", lambda t: "/voice-settings" in t)
            send("\r")
            wait("settings", lambda t: "Voice settings" in t and "alt+r" in t and "Absent iPhone" in t)
            send("Microphone")
            wait("filtered", lambda t: "Microphone" in t and "Transcription" not in t)
            send("\r")
            wait("pin", lambda t: "Saved, not listed" in t and "Absent iPhone" in t and "Desk" in t)
            send("\x1b")
            wait("reopened", lambda t: "Voice settings" in t and "alt+r" in t and "Absent iPhone" in t)

    fresh = install("clean", candidate)
    version = subprocess.check_output([*cmd, "--version"], cwd=root/"project", env=fresh, text=True).strip()
    qa.check(version.removeprefix("opencode v") == "2.4.1", version)
    new = state(fresh, "rage")
    migrate(fresh, "no legacy settings")
    qa.check(not new.parent.exists(), "fresh migration created a state directory")
    with terminal("fresh", fresh) as ui:
        skip(*ui, new)
    with terminal("fresh-restart", fresh) as (send, wait):
        wait("home", lambda t: "2.4.1" in t and "●" in t)
        send("/voice-settings")
        wait("slash", lambda t: "/voice-settings" in t)
        send("\r")
        wait("settings", lambda t: "Voice settings" in t and "No shortcut" in t)

    upgrade = install("upgrade", old, expected)
    legacy = state(upgrade, "opencode-voice")
    with terminal("prior", upgrade) as ui:
        skip(*ui, legacy)
    data = json.loads(legacy.read_text())
    qa.check(all(data.get(k) == v for k, v in expected.items()), f"prior did not save fixture: {data}")
    original = qa.sha(legacy)
    target = state(upgrade, "rage")
    qa.check(not target.exists(), "unexpected pre-existing Rage settings")
    # A launch without running the migration still gets the new ID's normal first-run experience.
    control = install("old-only", candidate)
    old_only = state(control, "opencode-voice")
    old_only.parent.mkdir(parents=True)
    shutil.copyfile(legacy, old_only)
    with terminal("old-id-only", control) as (_, wait):
        wait("setup", lambda t: setup_title in t)
    qa.check(qa.sha(old_only) == original, "old-only launch changed prior settings")
    # Follow the install instructions: host closed, run the packed command, replace the plugin, restart.
    migrate(upgrade, "migrated legacy settings")
    qa.check(qa.sha(target) == original and target.stat().st_mode & 0o777 == 0o600, "incomplete/private copy")
    upgrade = install("upgrade", candidate)
    for label in ("first-upgrade", "upgrade-restart"):
        if (cache/"recordings").exists():
            (cache/"recordings").rmdir()  # next launch must recreate it from persisted settings
        effective(label, upgrade)
        saved = json.loads(target.read_text())
        qa.check(all(saved.get(k) == v for k, v in data.items()), "copied settings changed")
        qa.check(qa.sha(legacy) == original, "candidate changed prior settings")
        before = target.read_bytes()
        migrate(upgrade, "kept existing Rage settings")
        qa.check(target.read_bytes() == before, "migration overwrote active settings")
    events = (root/"inventory.log").read_text().splitlines()
    qa.check(events and set(events) == {"inventory"}, "unexpected recording attempt")
    return dict(host=version, priorRevision=previous_sha, candidateSHA256=qa.sha(archive),
                addonSHA256=qa.sha(candidate/"native/rage.node"), settings=expected,
                coreSHA256=qa.sha(candidate/"native/target/release/rage-core"),
                freshSkipPersisted=True, oldOnlyShowsOnboarding=True, legacyUnchanged=True,
                migration="explicit packed command, mode 0600; existing state kept on both reruns",
                copiedEffectiveLaunches=2, inventoryCalls=len(events), captureAttempts=0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path)
    parser.add_argument("prior", type=Path)
    parser.add_argument("--rev", default="6d3f64c")
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix="settings-restart-")).resolve()
    print(f"Evidence: {root}", flush=True)
    result = run(root, args.assets.resolve(), args.prior.resolve(), args.rev)
    qa.dump(root/"result.json", result)
    print(json.dumps(result, indent=2))
