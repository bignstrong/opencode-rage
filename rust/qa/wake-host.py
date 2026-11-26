"""Offline macOS acceptance: run the packed plugin inside OpenCode using timed WAV input."""
import argparse
from array import array
import contextlib
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time
import wave

sys.dont_write_bytecode = True
here = Path(__file__).resolve().parent
repo = here.parents[1]
spec = importlib.util.spec_from_file_location("restart", here / "settings-restart.py")
restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restart)
qa = restart.qa
rate = 16000
clock = time.monotonic


def fixture(root, env=None, commands=("открой настройки", "открой настройки")):
    phrases = {}
    for i, command in enumerate(dict.fromkeys(commands), 1):
        caf, wav = root / f"phrase-{i}.caf", root / f"phrase-{i}.wav"
        name_end = float(subprocess.check_output(
            ["swift", here / "wake-markers.swift", caf, f"Рейдж {command}"], env=env))
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
                        caf, wav], check=True)
        with wave.open(str(wav)) as f:
            signal = array("h", f.readframes(f.getnframes()))
        # Last 10 ms window above -50 dBFS, independent of the listener's endpoint.
        end = max(i for i in range(0, len(signal), 160)
                  if sum(x*x for x in signal[i:i+160]) / 160 > 32768**2 * 1e-5) / rate + .01
        phrases[command] = signal, name_end, end
    source = root / "input.wav"
    gap, start = 3, 8
    marks = []
    with wave.open(str(source), "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        rng = random.Random(329)
        # A non-word tone changes the visible input meter without waking the listener.
        wav.writeframes(bytes(2 * rate * 2))
        wav.writeframes(array("h", (rng.randrange(-180, 181) for _ in range(4 * rate))).tobytes())
        wav.writeframes(array("h", (round(5000 * math.sin(i * math.tau * 310 / rate))
                                    for i in range(rate))).tobytes())
        wav.writeframes(bytes(rate * 2))
        for index, command in enumerate(commands):
            if index:
                wav.writeframes(bytes(gap * rate * 2))
            signal, name_end, end = phrases[command]
            wav.writeframes(signal.tobytes())
            marks.append((start + name_end, start + end))
            start += len(signal) / rate + gap
        wav.writeframes(bytes(20 * rate * 2))
    return marks


def listeners(core):
    rows = subprocess.check_output(["ps", "-axo", "pid=,time=,rss=,command="], text=True)
    result = {}
    for row in rows.splitlines():
        pid, used, rss, cmd = row.split(maxsplit=3)
        if cmd.startswith(str(core) + " listen "):
            result[int(pid)] = (sum(float(s) * 60**i for i, s in enumerate(reversed(used.split(":")))),
                                int(rss))
    return result


def prepare(root, assets, provider_port=None):
    pkg, home, tmp, project, voice = [root / n for n in ("package", "home", "tmp", "project", "voice")]
    for path in (home, tmp, project):
        path.mkdir()
    pack_env = dict(PATH=os.environ["PATH"], HOME=str(home), TMPDIR=f"{tmp}/",
                    XDG_CACHE_HOME=str(home / "cache"))
    archive = root / json.loads(subprocess.check_output([
        "npm", "pack", "--json", "--offline", "--ignore-scripts", "--cache", root / "npm-cache",
        "--userconfig", home / ".npmrc", "--globalconfig", "/dev/null", "--pack-destination", root],
        cwd=repo, env=pack_env))[0]["filename"]
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter="data")
    core = pkg / "native/target/release/rage-core"
    qa.check(core.is_file() and (pkg / "native/rage.node").is_file(), "build native artifacts before packing")
    subprocess.run(["/bin/cp", "-cR", repo / "node_modules", pkg / "node_modules"], check=True)
    model = voice / "models" / qa.MODEL
    model.parent.mkdir(parents=True)
    subprocess.run(["/bin/cp", "-c", assets / "voice/models" / qa.MODEL, model], check=True)
    qa.check(qa.sha(model) == qa.DIGEST, "unexpected model")
    s = model.stat()
    model.with_suffix(".gguf.sha256").write_text(
        f"{qa.DIGEST} {s.st_dev}:{s.st_ino}:{s.st_size}:{s.st_mtime_ns}:{s.st_ctime_ns}")
    engine = root / "opencode-voice-transcribe"
    shutil.copy2(assets / engine.name, engine)
    qa.check(qa.sha(engine) == json.loads((assets / "result.json").read_text())["engineSHA256"], "engine")
    cfg = home / "config/opencode"
    cfg.mkdir(parents=True)
    options = dict(model="handy-gigaam-v3-e2e-ctc-gguf", language="ru", uiLanguage="en",
                   autoSubmit=True, recordingHotkey="alt+r", voiceEnhance=False, voiceAnimation=False,
                   downloadDir=str(voice))
    state = home / "state/opencode/latest/tui/plugin.rage.settings.json"
    state.parent.mkdir(parents=True)
    qa.dump(state, {**options, "onboardingDone": True, "hotkeyMigratedV3": True})
    qa.dump(cfg / "cli.json", {"plugins": [{"package": str(pkg), "options": options}],
                              "animations": False, "attention": {"sound": False, "notifications": False}})
    plugins = []
    if provider_port is None:
        guard = root / "refuser"
        guard.mkdir()
        qa.dump(guard / "package.json", {"name": "qa-refuse-prompt", "version": "1.0.0", "type": "module",
                                         "exports": {"./server": "./server.js"}})
        shutil.copy2(here / "failure-server.js", guard / "server.js")
        plugins.append({"package": str(guard)})
    port = provider_port or 1
    qa.dump(cfg / "opencode.json", {"plugins": plugins, "update": "disable",
            "model": "qa/fixture", "snapshots": False,
            "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                         {"action": "provider.use", "resource": "qa", "effect": "allow"}],
            "providers": {"qa": {"env": ["QA_KEY"], "models": {"fixture": {}},
                "package": "@opencode/ai/providers/openai-compatible",
                 "settings": {"baseURL": f"http://127.0.0.1:{port}/v1"}}}})
    env = dict(HOME=str(home), TMPDIR=f"{tmp}/", TERM="xterm-256color", LANG="en_US.UTF-8",
               COLORTERM="truecolor", PATH="/opt/homebrew/bin:/usr/bin:/bin", QA_RUN=str(root), QA_KEY="fixture",
               RAGE_LISTEN_WAV=str(root / "input.wav"), OPENCODE_VOICE_TRANSCRIBE_CPP=str(engine),
               RAGE_TRAINING_DIR=str(root / "training"),
               OPENCODE_VOICE_DIR=str(voice), XDG_RUNTIME_DIR=str(tmp), GIT_CONFIG_NOSYSTEM="1",
               OPENCODE_DISABLE_MODELS_FETCH="1", OPENCODE_DISABLE_PROJECT_CONFIG="1")
    for key in ("CONFIG", "STATE", "DATA", "CACHE"):
        env[f"XDG_{key}_HOME"] = str(home / key.lower())
    # Standalone OpenCode starts its own loopback API on an ephemeral port.
    policy = ('(version 1)(allow default)(deny device-microphone)(deny network-outbound (remote ip "*:*"))'
              '(allow network-outbound (remote ip "localhost:*"))'
              f'(deny file-read* file-write* (subpath {json.dumps(str(Path.home().resolve()))}))')
    host = ["/usr/bin/sandbox-exec", "-p", policy, str(Path(shutil.which("opencode")).resolve())]
    return archive, core, home, tmp, voice, project, host, env


def create_session(host, env, project, title):
    return json.loads(subprocess.check_output([*host, "api", "--standalone", "session.create", "-d",
                      json.dumps({"title": title})], env=env, cwd=project, timeout=20))["data"]["id"]


def composer(t):
    return " ".join(" ".join(line[3:108].strip() for line in t.splitlines()[-10:]
                    if line.startswith("  ┃") and "Build ·" not in line).split()).lower()


def run(root, assets):
    archive, core, home, tmp, voice, project, host, env = prepare(root, assets)
    marks = fixture(root)
    version = subprocess.check_output([*host, "--version"], env=env, cwd=project, text=True).strip()
    title = "Wake fixture"
    session = create_session(host, env, project, title)
    cmd = [*host, "--standalone", "--session", session]

    def start(send, wait):
        wait("ready", lambda t: title in t and "●" in t)
        qa.check(not listeners(core), "listener before opt-in")
        send("/rage-listen")
        wait("slash", lambda t: "/rage-listen" in t)
        t0 = clock()
        send("\r")
        wait("waiting", lambda t: waiting(t))
        return t0, clock()

    def waiting(t):
        return "waiting for" in t.lower()

    def hearing(t):
        return "wake word heard" in t.lower()

    def cleaned():
        return not listeners(core) and not any(tmp.rglob("*.wav")) and not any(voice.rglob("*.wav"))

    def toggle_palette(send, wait):
        send("\x10")
        wait("palette", lambda t: "Search commands" in t)
        send("rage-listen")
        wait("filtered", lambda t: "rage-listen" in t.lower() and "Switch model" not in t)
        send("\r")

    delays = []
    draft = "открой настройки"
    prefix = "мой черновик"
    def draft_count(t, count, suffix=""):
        return re.findall(r"\w+", composer(t)) == prefix.split() + draft.split() * count + suffix.split()

    with restart.screen_session(root, "commands", cmd, env) as (send, wait):
        before, ready = start(send, wait)
        send(prefix + " ")
        wait("original-draft", lambda t: draft_count(t, 0))
        wait("quiet-input", lambda t: waiting(t) and re.search(r"silence|quiet", t, re.I))
        samples = []
        # Sample the native listener before the first audio, on the single realtime source.
        for _ in range(10):
            live = listeners(core)
            qa.check(len(live) == 1, f"expected one listener: {live}")
            used, rss = next(iter(live.values()))
            samples.append((clock(), used, rss))
            time.sleep(.45)
        qa.check(not list(tmp.rglob("*.wav")) and not list(voice.rglob("*.wav")), "idle recording on disk")
        wait("audible-input", lambda t: waiting(t) and re.search(r"sound|signal", t, re.I))
        for i, (name, end) in enumerate(marks, 1):
            wait(f"heard-{i}", hearing)
            heard = clock()
            wait(f"draft-{i}", lambda t: draft_count(t, i))
            delivered = clock()
            # Bracket WAV start between toggle and first waiting indicator. No plugin instrumentation.
            delays.append({"nameEndToIndicatorMs": [round((heard-t-name)*1000) for t in (ready, before)],
                           "commandEndToDraftMs": [round((delivered-t-end)*1000) for t in (ready, before)]})
            wait(f"rearmed-{i}", waiting)
        toggle_palette(send, wait)
        wait("off", lambda t: cleaned() and not waiting(t) and not hearing(t))
        qa.check(draft_count((root / "commands-off.txt").read_text(), 2), "draft changed")
        send("editable")
        wait("edited", lambda t: draft_count(t, 2, "editable"))
    with restart.screen_session(root, "switch-during-turn", cmd, env) as (send, wait):
        start(send, wait)
        wait("heard", hearing)
        send("\x18")
        send("n")
        wait("new-context", lambda t: cleaned() and not hearing(t) and not waiting(t))
        send("new draft")
        wait("clean-editor", lambda t: "new draft" in t and draft not in t.lower())
    with restart.screen_session(root, "host-close", cmd, env) as (send, wait):
        start(send, wait)
        wait("heard", hearing)
    deadline = clock() + 4
    while not cleaned() and clock() < deadline:
        time.sleep(.05)
    qa.check(cleaned(), "orphaned listener or take after host close")
    qa.check(not list((root / "training").glob("*")), "demo audio entered the training corpus")
    qa.check(not (root / "refused.jsonl").exists() and not (root / "unexpected-provider").exists(),
             "wake adapter attempted to submit")
    with contextlib.closing(sqlite3.connect(
            f"file:{home / 'data/opencode/opencode.db'}?mode=ro", uri=True)) as db:
        qa.check(not db.execute("SELECT count(*) FROM session_inbox").fetchone()[0], "inbox not empty")
        qa.check(not db.execute("SELECT count(*) FROM session_message").fetchone()[0], "messages created")
    secs = samples[-1][0] - samples[0][0]
    return dict(host=version, archiveSHA256=qa.sha(archive), wavSHA256=qa.sha(root/"input.wav"),
                source="synthetic Milena; real-time WAV, no device", commands=2, sends=0,
                delays=delays, idleSeconds=round(secs, 2),
                idleCpuPercent=round((samples[-1][1]-samples[0][1])*100/secs, 2),
                idleRssMiB=round(statistics.median(x[2] for x in samples)/1024, 2),
                noListenerOrWavAfterToggleAndHostExit=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path, help="successful installed-dictation.py --keep run")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix="rage-wake-")).resolve()
    print(f"Evidence: {root}", flush=True)
    result = run(root, args.assets.resolve())
    qa.dump(root / "result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.keep:
        shutil.rmtree(root)
