"""Packed OpenCode acceptance for two wake auto-sends and a zero-send draft control."""
import argparse
import contextlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("wake_host", Path(__file__).with_name("wake-host.py"))
wake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wake)
qa = wake.qa
commands = ("открой настройки", "открой календарь")


@contextlib.contextmanager
def provider(root):
    posts = []

    class Sink(BaseHTTPRequestHandler):
        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            posts.append({"path": self.path, "body": data})
            qa.dump(root / "provider-posts.json", posts)
            if self.path != "/v1/chat/completions" or data.get("model") != "fixture" or not data.get("stream"):
                self.send_error(400, "expected fixture streaming completion")
                return
            turn = len(posts)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in [({"role": "assistant", "content": f"wake-fixture-ack-{turn}"}, None),
                                  ({}, "stop")]:
                chunk = dict(id=f"wake-{turn}", object="chat.completion.chunk", created=1, model="fixture",
                             choices=[dict(index=0, delta=delta, finish_reason=finish)])
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")

        def log_message(self, *_):
            pass

    # No request is forwarded. Run server on a single thread to preserve wire order.
    with HTTPServer(("127.0.0.1", 0), Sink) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port, posts
        finally:
            server.shutdown()
            thread.join()


def stored(home):
    path = home / "data/opencode/opencode.db"
    with contextlib.closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as db:
        messages = db.execute("""
            SELECT m.session_id, m.type, json_extract(
                CASE WHEN m.type = 'user' THEN m.data ELSE p.data END, '$.text')
            FROM session_message m
            LEFT JOIN session_part p ON p.message_id = m.id AND p.type = 'text'
            WHERE m.type IN ('user', 'assistant')
            ORDER BY m.session_id, m.seq, p.ordinal
        """).fetchall()
        inbox = db.execute("SELECT count(*) FROM session_inbox").fetchone()[0]
    return messages, inbox


def user_text(message):
    content = message["content"]
    if isinstance(content, str):
        return content
    return "".join(part["text"] for part in content if part["type"] == "text")


def words(text):
    return re.findall(r"\w+", text.casefold())


def run(root, assets, port, posts):
    archive, core, home, _, _, project, host, env = wake.prepare(root, assets, port)
    wake.fixture(root, {**env, "CLANG_MODULE_CACHE_PATH": str(root / "swift-cache")}, commands)
    version = subprocess.check_output([*host, "--version"], env=env, cwd=project, timeout=20, text=True).strip()
    qa.check(version.removeprefix("opencode v") == "2.4.1", f"expected OpenCode 2.4.1, got {version}")

    def launch(label, title):
        session = wake.create_session(host, env, project, title)
        return session, wake.restart.screen_session(root, label, [*host, "--standalone", "--session", session], env)

    def start(send, wait, title, slash):
        wait("ready", lambda t: title in t and "●" in t)
        qa.check(not wake.listeners(core), "listener started without opt-in")
        send("/" + slash)
        wait("slash", lambda t: "/" + slash in t)
        send("\r")
        wait("armed", lambda t: "waiting for" in t.lower() and len(wake.listeners(core)) == 1
             and ("auto-send ·" in t.lower()) == (slash == "rage-auto"))

    def stop(send, wait, slash):
        send("\x10")
        wait("palette", lambda t: "Search commands" in t)
        send(slash)
        wait("filtered", lambda t: slash in t.lower() and "Switch model" not in t)
        send("\r")
        wait("off", lambda t: "waiting for" not in t.lower() and not wake.listeners(core))

    title = "Wake draft control"
    control, screen = launch("listen", title)
    with screen as (send, wait):
        start(send, wait, title, "rage-listen")
        for turn in (1, 2):
            wait(f"draft-{turn}", lambda t: words(wake.composer(t)) == " ".join(commands[:turn]).split())
        stop(send, wait, "rage-listen")
    qa.check(not posts and stored(home) == ([], 0), "/rage-listen sent or enqueued a prompt")

    title = "Wake auto-send"
    session, screen = launch("auto", title)
    qa.check(session != control, "control and auto must use different sessions")
    with screen as (send, wait):
        start(send, wait, title, "rage-auto")
        for turn in (1, 2):
            wait(f"ack-{turn}", lambda t: f"wake-fixture-ack-{turn}" in t)
            qa.check(len(posts) == turn, f"expected {turn} provider request(s) at acknowledgement")
        stop(send, wait, "rage-auto")

    qa.check(len(posts) == 2, f"expected exactly two provider requests, got {len(posts)}")
    sent = []
    for turn, post in enumerate(posts, 1):
        turns = [user_text(m) for m in post["body"]["messages"] if m["role"] == "user"]
        qa.check(len(turns) == turn and turns[:-1] == sent and words(turns[-1]) == commands[turn - 1].split(),
                 f"request {turn} user history: {turns!r}")
        sent.append(turns[-1])

    rows, inbox = stored(home)
    qa.check(not inbox, "inbox not empty after both replies")
    user = [(sid, text) for sid, role, text in rows if role == "user"]
    qa.check(user == [(session, text) for text in sent], f"expected two exact prompts in {session}: {user!r}")
    assistant = [(sid, text) for sid, role, text in rows if role == "assistant"]
    qa.check(assistant == [(session, f"wake-fixture-ack-{turn}") for turn in (1, 2)], f"replies: {assistant!r}")
    return dict(host=version, archiveSHA256=qa.sha(archive), wavSHA256=qa.sha(root / "input.wav"),
                session=session, controlSession=control, autoSends=len(user), providerPOSTs=len(posts),
                listenSends=0, pending=0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path, help="successful installed-dictation.py --keep run")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix="rage-wake-auto-")).resolve()
    print(f"Evidence: {root}", flush=True)
    with provider(root) as (port, posts):
        result = run(root, args.assets.resolve(), port, posts)
    qa.dump(root / "result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.keep:
        shutil.rmtree(root)
