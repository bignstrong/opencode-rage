#!/usr/bin/env python3
"""macOS / Python 3.12+ with pyte: cold-ui.py <retained installed-dictation run>.

Use its trusted npm tarball and catalog-pinned model as fixture inputs only.
Print the evidence directory. Retain terminal snapshots, not the isolated home or TLS key.
"""
import argparse
import gzip
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("restart", Path(__file__).with_name("settings-restart.py"))
restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restart)
qa = restart.qa


def run(root, source):
    archive, = source.glob("*.tgz")
    receipt = json.loads((source / "result.json").read_text())
    assert qa.sha(archive) == receipt["archiveSHA256"]
    weights = source / "voice/models" / qa.MODEL
    assert qa.sha(weights) == qa.DIGEST
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter="data")
    pkg = root / "package"
    subprocess.run(["/bin/cp", "-cR", qa.REPO / "node_modules", pkg / "node_modules"], check=True)
    (root / "project").mkdir()
    home = root / "home"
    env = dict(HOME=str(home), TMPDIR=str(root), PATH="/opt/homebrew/bin:/usr/bin:/bin",
               LANG="en_US.UTF-8", TERM="xterm-256color", COLORTERM="truecolor", GIT_CONFIG_NOSYSTEM="1")
    for k in ("CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"):
        p = home / k.lower()
        p.mkdir(parents=True)
        env["XDG_RUNTIME_DIR" if k == "RUNTIME" else f"XDG_{k}_HOME"] = str(p)
    # Only curl inside the private host trusts this short-lived certificate.
    cert, key = root / "fixture.pem", root / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=huggingface.co", "-addext", "subjectAltName=DNS:huggingface.co",
                    "-keyout", key, "-out", cert], env=env, check=True, capture_output=True)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    binary = b"#!/bin/sh\n[ \"$1\" = --help ] && echo '--model --file'\n"
    compressed = gzip.compress(binary)
    calls = {"engine": 0, "model": 0}
    release = {k: threading.Event() for k in ("engine", "progress", "retry")}
    model_path = "/handy-computer/gigaam-v3-e2e-ctc-gguf/resolve/075dff81f843cf23d22b4ce943ffdc4dd8650cd7/" + qa.MODEL

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_CONNECT(self):
            # Terminate only the catalog fixture here. No forwarding, no upstream socket.
            if self.path != "huggingface.co:443":
                return self.send_error(403)
            self.send_response(200)
            self.end_headers()
            with tls.wrap_socket(self.connection, server_side=True) as conn:
                Fixture(conn, self.client_address, self.server)

        def do_GET(self):
            if self.path == "/engine.gz":
                calls["engine"] += 1
                if calls["engine"] == 2:
                    release["engine"].wait(12)
                data = bytes(len(compressed)) if calls["engine"] == 1 else compressed
            elif self.path == model_path:
                calls["model"] += 1
                n = calls["model"]
                if n == 2:
                    release["retry"].wait(12)
                data = bytes(256 * 1024) if n <= 2 else None
            else:
                return self.send_error(404)
            self.send_response(200)
            self.send_header("Content-Length", str(len(data) if data is not None else weights.stat().st_size))
            self.end_headers()
            if data is None:
                with weights.open("rb") as f:
                    shutil.copyfileobj(f, self.wfile)
            elif self.path == model_path and n == 1:
                self.wfile.write(data[:len(data)//2])
                release["progress"].wait(12)
                self.wfile.write(data[len(data)//2:])
            else:
                self.wfile.write(data)

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}"
        env.update(https_proxy=url, no_proxy="127.0.0.1,localhost", CURL_CA_BUNDLE=str(cert))
        registry = root / "registry.json"
        arch = {"arm64": "arm64", "x86_64": "x64"}[os.uname().machine]
        asset = dict(kind="single-binary-gzip", url=url+"/engine.gz", sha256=hashlib.sha256(compressed).hexdigest(),
                     binary={"sha256": hashlib.sha256(binary).hexdigest()})
        qa.dump(registry, {"schema": "opencode-voice.engines.v1", "engines": {
            "transcribe-cpp": {"assets": {f"darwin-{arch}": asset}}}})
        cache = root / "voice"
        cfg = home / "config/opencode"
        cfg.mkdir()
        qa.dump(cfg/"cli.json", {"plugins": [{"package": str(pkg), "options": dict(uiLanguage="en",
            engineRegistry=str(registry), engineDownloadRetries=2, downloadRetries=2, downloadDir=str(cache))}],
            "animations": False, "attention": {"notifications": False, "sound": False}})
        qa.dump(cfg/"opencode.json", {"update": "disable", "snapshots": False, "policies": [
            {"action": "provider.use", "resource": "*", "effect": "deny"}]})
        sandbox = ('(version 1)(allow default)(deny device-microphone)(deny network-outbound (remote ip "*:*"))'
                   '(allow network-outbound (remote ip "localhost:*"))(deny network-bind (local ip "*:*"))'
                   '(allow network-bind (local ip "localhost:*"))'
                   '(deny process-exec (regex #"/(ffmpeg|sox|rec|arecord|pbcopy|pbpaste)$"))'
                   f'(deny file-read* file-write* (subpath {json.dumps(str(Path.home().resolve()))}))')
        cmd = ["/usr/bin/sandbox-exec", "-p", sandbox, str(Path(shutil.which("opencode")).resolve())]
        assert subprocess.check_output([*cmd, "--version"], cwd=root, env=env, text=True).strip() == "opencode v2.4.1"
        with restart.screen_session(root, "host", [*cmd, "--standalone"], env) as (send, wait):
            wait("onboarding", lambda t: restart.setup_title in t)
            send("gigaam-v3-e2e-ctc")
            wait("filtered", lambda t: "gigaam-v3-e2e-ctc" in t and "Whisper Small" not in t)
            send("\r")
            wait("engine-retry", lambda t: "Engine install retry 2/2" in t and "SHA256" in t and "mismatch" in t)
            release["engine"].set()
            wait("progress", lambda t: bool(re.search(r"Downloading model [1-9]\d?%", t)))
            release["progress"].set()
            wait("model-retry", lambda t: "retrying download" in t)
            release["retry"].set()
            wait("failed", lambda t: "Download failed" in t)
            assert not (cache/"models"/qa.MODEL).exists()
            send("/voice-settings")
            wait("slash", lambda t: "/voice-settings" in t and "Open local voice input settings" in t)
            send("\r")
            wait("settings", lambda t: "Voice settings" in t and "Transcription" in t)
            send("Transcription\r")
            wait("recovery", lambda t: "Show download error" in t and "Download model" in t)
            send("Show download error\r")
            wait("detail", lambda t: "SHA256 mismatch" in t)
            send("\r")
            wait("back", lambda t: "Show download error" in t and "Download model" in t)
            send("Download model\r")
            wait("ready", lambda t: "Dictation ready" in t)
        server.shutdown()
    assert calls == {"engine": 2, "model": 3}, calls
    assert qa.sha(cache/"models"/qa.MODEL) == qa.DIGEST
    assert (cache/"models"/(qa.MODEL + ".sha256")).is_file()
    assert (cache/"engines/transcribe-cpp"/f"darwin-{arch}"/"opencode-voice-transcribe").read_bytes() == binary
    qa.dump(root/"result.json", dict(host="2.4.1", archive=receipt["archiveSHA256"], gets=calls, modelSHA256=qa.DIGEST))


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("installed_run", type=Path)
    evidence = Path(tempfile.mkdtemp(prefix="rage-cold-ui-"))
    print("Terminal evidence:", evidence, flush=True)
    with tempfile.TemporaryDirectory() as work:
        root = Path(work).resolve()
        try:
            run(root, args.parse_args().installed_run.resolve())
        finally:
            for f in [*root.glob("host-*.txt"), root/"result.json"]:
                if f.is_file():
                    shutil.copyfile(f, evidence/f.name)
