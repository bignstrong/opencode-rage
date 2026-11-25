"""OpenCode 2.4.1 installed PTY, real packed Rage, synthetic PCM, no upstream provider.

python failure-host.py path/to/successful/rage-installed-run [--archive trusted.tgz] [--keep]
"""
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("restart", here / "settings-restart.py")
restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restart)
qa = restart.qa


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def run(root, assets, archive):
    baseline = json.loads((assets / "result.json").read_text())
    if not archive:
        archive, = assets.glob("*.tgz")
        qa.check(qa.sha(archive) == baseline["archiveSHA256"], "fixture archive changed")
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter="data")
    pkg = root / "package"
    subprocess.run(["/bin/cp", "-cR", assets / "package/node_modules", pkg / "node_modules"], check=True)
    voice = root / "voice"
    models = voice / "models"
    models.mkdir(parents=True)
    model = models / qa.MODEL
    for src, dst, fingerprint in [(assets / "voice/models" / qa.MODEL, model, qa.DIGEST),
                                 (assets / "input.wav", root / "input.wav", baseline["wavSHA256"]),
                                 (assets / "opencode-voice-transcribe", root / "fixture-asr", baseline["engineSHA256"])]:
        subprocess.run(["/bin/cp", "-c", src, dst], check=True)
        qa.check(qa.sha(dst) == fingerprint, f"unexpected fixture: {src.name}")
    s = model.stat()
    model.with_suffix(".gguf.sha256").write_text(
        f"{qa.DIGEST} {s.st_dev}:{s.st_ino}:{s.st_size}:{s.st_mtime_ns}:{s.st_ctime_ns}")
    for name, script in [("ffmpeg", "recorder.py"), ("opencode-voice-transcribe", "failure-decoder.py")]:
        exe = root / name
        exe.write_text("#!/usr/bin/python3\n" + (here / script).read_text())
        exe.chmod(0o700)
    project, home, tmp = (root / n for n in ("project", "home", "tmp"))
    for path in (project, home, tmp):
        path.mkdir()
    attachment = project / "qa-note.txt"
    attachment.write_text("Synthetic file attachment for QA.\n")
    env = dict(HOME=str(home), TMPDIR=f"{tmp}/", TERM="xterm-256color", COLORTERM="truecolor",
               LANG="en_US.UTF-8", PATH=f"{root}:/opt/homebrew/bin:/usr/bin:/bin", QA_RUN=str(root),
               QA_KEY="offline-fixture", GIT_CONFIG_NOSYSTEM="1", XDG_RUNTIME_DIR=str(tmp),
               RAGE_FFMPEG=str(root / "ffmpeg"), OPENCODE_VOICE_FFMPEG=str(root / "ffmpeg"),
               OPENCODE_VOICE_TRANSCRIBE_CPP=str(root / "opencode-voice-transcribe"), OPENCODE_VOICE_DIR=str(voice))
    for key in ("CONFIG", "DATA", "STATE", "CACHE"):
        env[f"XDG_{key}_HOME"] = str(home / key.lower())
    policy = ('(version 1)(allow default)(deny device-microphone)(deny network-outbound (remote ip "*:*"))'
              '(allow network-outbound (remote ip "localhost:*"))'
              '(deny process-exec (regex #"/(ffmpeg|sox|rec|arecord|pbcopy|pbpaste)$"))'
              f'(allow process-exec (literal {json.dumps(str(root / "ffmpeg"))}))'
              f'(deny file-read* file-write* (subpath {json.dumps(str(Path.home().resolve()))}))')
    host = ["/usr/bin/sandbox-exec", "-p", policy, str(Path(shutil.which("opencode")).resolve()), "--standalone"]

    def cli(*args):
        result = subprocess.run([*host[:-1], args[0], "--standalone", *args[1:]], env=env, cwd=project,
                                capture_output=True, timeout=20, text=True)
        qa.check(not result.returncode, result.stderr + result.stdout)
        return result.stdout.strip()

    version = cli("--version")
    qa.check(version.removeprefix("opencode v") == "2.4.1", version)
    server = root / "refuser"
    server.mkdir()
    qa.dump(server / "package.json", {"name": "qa-refuse-prompt", "version": "1.0.0", "type": "module",
                                      "exports": {"./server": "./server.js"}})
    shutil.copyfile(here / "failure-server.js", server / "server.js")
    cfg = home / "config/opencode"
    cfg.mkdir(parents=True, exist_ok=True)
    options = dict(model="handy-gigaam-v3-e2e-ctc-gguf", language="ru", uiLanguage="en",
                   autoSubmit=True, recordingHotkey="alt+r", voiceEnhance=False, voiceAnimation=False,
                   mic=":uid:1:Fixture", downloadDir=str(voice))
    state = home / "state/opencode/latest/tui/plugin.rage.settings.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    qa.dump(state, {**options, "onboardingDone": True, "hotkeyMigratedV3": True})
    cli_config = {"plugins": [{"package": str(pkg), "options": options}], "animations": False,
                  "attention": {"sound": False, "notifications": False}}
    qa.dump(cfg / "cli.json", cli_config)
    qa.dump(cfg / "opencode.json", {"plugins": [{"package": str(server)}], "model": "qa/fixture",
            "update": "disable", "snapshots": False,
            "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                         {"action": "provider.use", "resource": "qa", "effect": "allow"}],
            "providers": {"qa": {"env": ["QA_KEY"], "models": {"fixture": {}},
                "package": "@opencode/ai/providers/openai-compatible",
                "settings": {"baseURL": "http://127.0.0.1:1/v1"}}}})
    transcript = baseline["transcript"]
    qa.check(len(transcript.split()) >= 3, "missing synthetic transcript")
    log = root / "refused.jsonl"

    def refused():
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def stored():
        db = home / "data/opencode/opencode.db"
        with contextlib.closing(sqlite3.connect(f"file:{db}?mode=ro", uri=True)) as conn:
            return dict(messageTypes=dict(conn.execute("SELECT type, count(*) FROM session_message GROUP BY type")),
                        inbox=conn.execute("SELECT count(*) FROM session_inbox").fetchone()[0])

    def session(title):
        return json.loads(cli("api", "session.create", "-d", json.dumps({"title": title})))["data"]["id"]

    def capture(send, wait):
        send("\x1br")
        wait("recording", lambda t: "■" in t)
        send("\x1br")

    def composer(t):
        return " ".join(" ".join(line[3:108].strip() for line in t.splitlines()[-10:]
                        if line.startswith("  ┃") and "Build ·" not in line).split())

    rejection_id = session("QA rejected prompt")
    with restart.screen_session(root, "reject", [*host, "--session", rejection_id], env) as (send, wait):
        wait("ready", lambda t: "QA rejected prompt" in t and "●" in t)
        send("@qa-note")
        wait("file-menu", lambda t: "qa-note.txt" in t)
        send("\r")
        wait("file-added", lambda t: "qa-note.txt" in composer(t))
        send(" KEEP REPLACE")
        wait("before", lambda t: "KEEP REPLACE" in composer(t))
        send("\x1b[1;2D" * len("REPLACE"))  # Shift+Left: select just the trailing word.
        capture(send, wait)
        wait("restored", lambda t: "UnexpectedStatus: 500" in t and "qa-note.txt" in composer(t) and
             "KEEP " + transcript in composer(t) and "REPLACE" not in composer(t))
        qa.check(refused() == [{"sessionID": rejection_id, "prompt": {"text": transcript}}],
                 f"wrong failed submission: {refused()}")
        qa.check(stored() == {"messageTypes": {}, "inbox": 0}, "failed admission persisted a message")
        send(" [edited]")
        wait("editable", lambda t: transcript + " [edited]" in composer(t))
        # Inspect the real native composer's attachment payload on an intentional second submission.
        send("\r")
        wait("manual-retry", lambda _: len(refused()) == 2)
        second = refused()[1]["prompt"]
        qa.check("KEEP " + transcript + " [edited]" in second["text"] and second["text"].count(transcript) == 1,
                 f"wrong editable draft: {second}")
        files = second.get("files", [])
        qa.check(len(files) == 1 and files[0]["uri"] == attachment.as_uri(), f"attachment lost: {files}")
        mention = files[0]["mention"]
        qa.check(second["text"][mention["start"]:mention["end"]] == mention["text"] == "@qa-note.txt",
                 "attachment no longer anchored in edited draft")

    unload_id = session("QA unload")
    (root / "gate").touch()
    with restart.screen_session(root, "unload", [*host, "--session", unload_id], env) as (send, wait):
        wait("ready", lambda t: "QA unload" in t and "●" in t)
        send("Unsent draft")
        wait("before", lambda t: "Unsent draft" in composer(t))
        capture(send, wait)
        wait("decoding", lambda _: (root / "decoded.json").exists())
        marker = json.loads((root / "decoded.json").read_text())
        pids = [marker["enginePID"], marker["corePID"]]
        stt = Path(marker["tmp"])
        qa.check(marker["text"] == transcript and all(map(alive, pids)) and stt.is_dir()
                 and list((voice / "recordings").rglob("*.wav")), "no live decode to cancel")
        qa.dump(cfg / "cli.next", {**cli_config, "plugins": []})
        (cfg / "cli.next").replace(cfg / "cli.json")
        wait("unloaded", lambda t: "ctrl+p commands" in t and not any(map(alive, pids))
             and not stt.exists() and not list((voice / "recordings").iterdir()))
        (root / "release").touch()
        send(" still editable")
        wait("after", lambda t: composer(t) == "Unsent draft still editable")
        qa.check(not (root / "emitted").exists() and len(refused()) == 2, "late decoder delivery")
    counts = stored()
    # The manual Enter can persist the host's model/agent selection even when prompt admission fails.
    qa.check(not counts["inbox"] and counts["messageTypes"].keys() <= {"agent-switched", "model-switched"},
             f"unexpected admitted messages: {counts}")
    qa.check(not (root / "unexpected-provider").exists(), "reached provider request hook")
    events = [json.loads(line)["event"] for line in (root / "capture.jsonl").read_text().splitlines()]
    qa.check([e for e in events if e != "inventory"] == ["start", "stop"] * 2, f"capture events: {events}")
    return dict(host=version, archiveSHA256=qa.sha(archive), transcript=transcript, submissions=refused(),
                promptStatus=500, providerRequests=0, selectedWordReplaced="REPLACE",
                unload=dict(cancelledPIDs=pids, decodeTempRemoved=True,
                takeRemoved=True, draft="Unsent draft still editable"), **counts)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix="rage-failure-")).resolve()
    print(f"Evidence: {root}", flush=True)
    result = run(root, args.assets.resolve(), args.archive)
    qa.dump(root / "result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.keep:
        shutil.rmtree(root)
