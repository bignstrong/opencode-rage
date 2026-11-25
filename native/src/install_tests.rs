use super::*;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::thread::{self, JoinHandle};

const HELLO: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

fn args(dir: &TempDir, url: &str) -> Value {
    json!({"model":{"implemented":true,"name":"test","filename":"weights.bin","url":url,"sha256":HELLO,"sizeMB":1},
        "options":{"downloadDir":dir.path(),"downloadRetries":1,"engineDownloadRetries":1,"arch":"arm64"}})
}
fn read_request(s: &TcpStream) -> String {
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut lines = BufReader::new(s);
    let mut req = String::new();
    while !req.ends_with("\r\n\r\n") {
        let n = lines.read_line(&mut req).unwrap();
        assert!(n > 0);
    }
    req
}
fn server(responses: Vec<Vec<u8>>) -> (String, JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let worker = thread::spawn(move || {
        responses
            .into_iter()
            .map(|response| {
                let start = Instant::now();
                let mut s = loop {
                    if let Ok((s, _)) = listener.accept() {
                        break s;
                    }
                    assert!(
                        start.elapsed() < Duration::from_secs(5),
                        "expected HTTP request"
                    );
                    thread::sleep(Duration::from_millis(5));
                };
                s.set_nonblocking(false).unwrap();
                let req = read_request(&s);
                let _ = s.write_all(&response);
                req
            })
            .collect()
    });
    (url, worker)
}
fn ok(body: &[u8]) -> Vec<u8> {
    [
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
        body,
    ]
    .concat()
}
fn assert_models(dir: &TempDir, expected: &[&str]) {
    let mut files: Vec<_> = fs::read_dir(dir.path().join("models"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(files, expected);
}

#[test]
fn follows_redirect_and_replaces_only_verified_model_with_legacy_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let (url, worker) = server(vec![
        b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\n\r\n".to_vec(),
        ok(b"hello"),
    ]);
    let a = args(&dir, &url);
    let path = dir.path().join("models/weights.bin");
    fs::create_dir(path.parent().unwrap()).unwrap();
    fs::write(&path, b"older").unwrap();
    assert_eq!(request("downloadModel", &a).unwrap(), json!(path));
    assert!(worker.join().unwrap()[1].starts_with("GET /final "));
    assert_eq!(fs::read(&path).unwrap(), b"hello");
    assert_eq!(
        crate::catalog::request("isModelDownloaded", &a).unwrap(),
        true
    );
    fs::write(suffix(&path, ".sha256"), HELLO).unwrap();
    assert_eq!(
        crate::catalog::request("isModelDownloaded", &a).unwrap(),
        false
    );
    assert_eq!(request("downloadModel", &a).unwrap(), json!(path)); // no listener remains
    assert_eq!(
        crate::catalog::request("isModelDownloaded", &a).unwrap(),
        true
    );
    assert_models(&dir, &["weights.bin", "weights.bin.sha256"]);
}

#[test]
fn short_download_is_claimed_and_resumed_using_the_exact_byte_range() {
    let dir = tempfile::tempdir().unwrap();
    let (url,worker) = server(vec![b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe".to_vec(),
        b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/5\r\n\r\nllo".to_vec()]);
    let a = args(&dir, &url);
    assert!(request("downloadModel", &a).is_err());
    assert_eq!(
        fs::read(dir.path().join("models/weights.bin.partial")).unwrap(),
        b"he"
    );
    request("downloadModel", &a).unwrap();
    assert!(
        worker.join().unwrap()[1]
            .to_ascii_lowercase()
            .contains("range: bytes=2-")
    );
    assert_models(&dir, &["weights.bin", "weights.bin.sha256"]);
}

#[test]
fn malformed_ranges_oversized_bodies_and_wrong_hash_leave_previous_install_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let (url, worker) = server(vec![
        b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 1-3/5\r\n\r\nllo".to_vec(),
        ok(b"wrong"), ok(&vec![0; 3*MIB as usize])]);
    let a = args(&dir, &url);
    fs::create_dir(dir.path().join("models")).unwrap();
    let file = dir.path().join("models/weights.bin");
    fs::write(&file, b"prior").unwrap();
    fs::write(suffix(&file, ".partial"), b"he").unwrap();
    for _ in 0..3 {
        assert!(request("downloadModel", &a).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"prior");
        assert_models(&dir, &["weights.bin"]);
    }
    worker.join().unwrap();
}

#[test]
fn cancellation_interrupts_stalled_http_and_preserves_published_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let mut a = args(
        &dir,
        &format!("http://{}/stall", listener.local_addr().unwrap()),
    );
    let flag = dir.path().join("cancel");
    a["cancelFile"] = json!(flag);
    let path = dir.path().join("models/weights.bin");
    fs::create_dir(path.parent().unwrap()).unwrap();
    fs::write(&path, b"prior").unwrap();
    let download = thread::spawn(move || request("downloadModel", &a));
    let (mut conn, _) = listener.accept().unwrap();
    read_request(&conn);
    conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nh")
        .unwrap();
    fs::write(flag, []).unwrap();
    assert!(download.join().unwrap().unwrap_err().contains("canceled"));
    assert_eq!(fs::read(path).unwrap(), b"prior");
    let mut b = [0];
    assert_eq!(conn.read(&mut b).unwrap(), 0);
}

#[test]
fn cannot_redirect_to_file_or_keep_an_oversized_chunked_response() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("private");
    fs::write(&secret, b"hello").unwrap();
    let chunk = vec![1; 3 * MIB as usize];
    let reply = [
        format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            chunk.len()
        )
        .as_bytes(),
        &chunk,
        b"\r\n0\r\n\r\n",
    ]
    .concat();
    let (url, worker) = server(vec![
        format!(
            "HTTP/1.1 302 Found\r\nLocation: file://{}\r\nContent-Length: 0\r\n\r\n",
            secret.display()
        )
        .into_bytes(),
        reply,
    ]);
    let a = args(&dir, &url);
    for _ in 0..2 {
        assert!(request("downloadModel", &a).is_err());
        assert_models(&dir, &[]);
    }
    worker.join().unwrap();
}

#[test]
fn server_ignoring_range_and_416_both_restart_from_zero() {
    for status in [200, 416] {
        let dir = tempfile::tempdir().unwrap();
        let mut responses = Vec::new();
        if status == 416 {
            responses
                .push(b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\n\r\n".to_vec());
        }
        responses.push(ok(b"hello"));
        let (url, worker) = server(responses);
        let a = args(&dir, &url);
        fs::create_dir(dir.path().join("models")).unwrap();
        fs::write(dir.path().join("models/weights.bin.partial"), b"stale").unwrap();
        request("downloadModel", &a).unwrap();
        let requests = worker.join().unwrap();
        assert!(requests[0].to_ascii_lowercase().contains("range: bytes=5-"));
        if status == 416 {
            assert!(!requests[1].to_ascii_lowercase().contains("range:"));
        }
        assert_models(&dir, &["weights.bin", "weights.bin.sha256"]);
    }
}

#[test]
fn invalid_model_paths_never_escape_the_managed_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = args(&dir, "unused");
    let outside = dir.path().join("valuable.bin");
    fs::write(&outside, b"keep").unwrap();
    a["model"]["filename"] = "../valuable.bin".into();
    assert!(request("removeModel", &a).is_err());
    a["model"]["filename"] = "valuable.bin".into();
    std::os::unix::fs::symlink(dir.path(), dir.path().join("models")).unwrap();
    assert!(request("removeModel", &a).is_err());
    assert_eq!(fs::read(outside).unwrap(), b"keep");
}

#[test]
fn model_import_checks_bytes_and_remove_cleans_receipt_and_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = args(&dir, "unused");
    let source = dir.path().join("weights");
    a["sourcePath"] = json!(source);
    fs::write(&source, b"wrong").unwrap();
    assert!(request("importModel", &a).is_err());
    fs::write(&source, b"hello").unwrap();
    request("importModel", &a).unwrap();
    assert_eq!(request("verifyModel", &a).unwrap(), true);
    fs::write(dir.path().join("models/weights.bin.partial"), b"he").unwrap();
    request("removeModel", &a).unwrap();
    assert_models(&dir, &[]);
    assert_eq!(fs::read(source).unwrap(), b"hello");
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut p = Command::new("/usr/bin/gzip")
        .arg("-c")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    p.stdin.take().unwrap().write_all(bytes).unwrap();
    let result = p.wait_with_output().unwrap();
    assert!(result.status.success());
    result.stdout
}
fn registry_fixture(dir: &TempDir, a: &mut Value, body: &[u8]) -> Value {
    let archive = dir.path().join("engine archive.gz");
    fs::write(&archive, gzip(body)).unwrap();
    let sha = |path| digest(&File::open(path).unwrap(), &Value::Null).unwrap();
    let exe = dir.path().join("original");
    fs::write(&exe, body).unwrap();
    let reg = dir.path().join("registry.json");
    a["options"]["engineRegistry"] = json!(reg);
    let asset = json!({"kind":"single-binary-gzip","url":format!("file://{}",archive.display()).replace(' ',"%20"),"sha256":sha(&archive),"binary":{"sha256":sha(&exe)}});
    let value = json!({"schema":"opencode-voice.engines.v1","version":"fixture-v1","engines":{"whisper.cpp":{"assets":{"darwin-arm64":asset}}}});
    fs::write(reg, serde_json::to_vec(&value).unwrap()).unwrap();
    value
}
const EXE: &[u8] = b"#!/bin/sh\nprintf '%s\\n' '--model --file'\n";

#[test]
fn registry_install_validates_both_hashes_before_running_or_publishing() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = args(&dir, "unused");
    let probed = dir.path().join("probed");
    let engine = format!(
        "#!/bin/sh\n: > '{}'\necho '--model --file'\n",
        probed.display()
    );
    let reg = registry_fixture(&dir, &mut a, engine.as_bytes());
    for (field, expected) in [
        (
            "no archive hash",
            "Engine registry must provide archive and binary SHA256 digests",
        ),
        (
            "bad binary hash",
            "Engine registry must provide archive and binary SHA256 digests",
        ),
        ("bad archive size", "Engine archive exceeds size limit"),
        ("bad binary size", "Engine binary exceeds size limit"),
        ("archive", "Engine archive SHA256 mismatch"),
        ("binary", "Engine binary SHA256 mismatch"),
    ] {
        let mut broken = reg.clone();
        let asset = &mut broken["engines"]["whisper.cpp"]["assets"]["darwin-arm64"];
        match field {
            "no archive hash" => {
                asset.as_object_mut().unwrap().remove("sha256");
            }
            "bad binary hash" => asset["binary"]["sha256"] = "invalid".into(),
            "bad archive size" => asset["size"] = 1.into(),
            "bad binary size" => asset["binary"]["size"] = 1.into(),
            "binary" => asset["binary"]["sha256"] = HELLO.into(),
            _ => asset["sha256"] = HELLO.into(),
        }
        fs::write(
            dir.path().join("registry.json"),
            serde_json::to_vec(&broken).unwrap(),
        )
        .unwrap();
        assert_eq!(request("installManagedEngine", &a).unwrap_err(), expected);
        assert!(!probed.exists(), "unverified binary reached probe: {field}");
        assert!(
            !dir.path()
                .join("engines/whisper.cpp/darwin-arm64/whisper-cli")
                .exists()
        );
    }
    fs::write(
        dir.path().join("registry.json"),
        serde_json::to_vec(&reg).unwrap(),
    )
    .unwrap();
    let result = request("installManagedEngine", &a).unwrap();
    assert!(probed.exists());
    assert_eq!(result["skipped"], false);
    assert_eq!(
        result["manifest"]["schema"],
        "opencode-voice.engine-install.v1"
    );
    assert_eq!(result["manifest"]["version"], "fixture-v1");
    assert_eq!(
        result["manifest"]["files"][0]["sha256"],
        reg["engines"]["whisper.cpp"]["assets"]["darwin-arm64"]["binary"]["sha256"]
    );
    assert_eq!(
        request("installManagedEngine", &a).unwrap()["skipped"],
        true
    );
}

#[cfg(target_os = "macos")]
#[test]
fn atomic_engine_update_and_import_keep_binary_and_provenance_together() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = args(&dir, "unused");
    registry_fixture(&dir, &mut a, EXE);
    let first = request("installManagedEngine", &a).unwrap();
    let bin = PathBuf::from(first["managedBinary"].as_str().unwrap());
    let source = dir.path().join("replacement");
    a["sourcePath"] = json!(source);
    fs::write(&source, b"#!/bin/sh\nexit 2\n").unwrap();
    assert!(request("importManagedEngine", &a).is_err());
    assert_eq!(fs::read(&bin).unwrap(), EXE);
    assert_eq!(
        request("readEngineManifest", &a).unwrap(),
        first["manifest"]
    );
    fs::write(&source, [EXE, b"# replacement\n"].concat()).unwrap();
    let second = request("importManagedEngine", &a).unwrap();
    let status = request("getEngineStatus", &a).unwrap();
    assert_eq!(status["managedInstalled"], true);
    assert_eq!(status["manifest"], second["manifest"]);
    assert_eq!(
        status["manifest"]["source"],
        json!({"type":"local-file","path":source})
    );
    assert_eq!(fs::read(&bin).unwrap(), fs::read(&source).unwrap());
    request("removeManagedEngine", &a).unwrap();
    assert!(!bin.exists());
    assert!(source.exists());
}

#[test]
fn rejects_unsigned_and_plaintext_remote_registries_before_connecting() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = args(&dir, "unused");
    a["options"]["engineRegistry"] = "http://127.0.0.1:1".into();
    assert!(
        request("loadEngineRegistry", &a)
            .unwrap_err()
            .contains("requires HTTPS")
    );
    a["options"]["engineRegistry"] = "https://127.0.0.1:1".into();
    a["options"]["engineRegistrySha256"] = "bad".into();
    assert!(
        request("loadEngineRegistry", &a)
            .unwrap_err()
            .contains("engineRegistrySha256")
    );
}

// Run the public entry point in a fresh process so protocol assertions include
// flushing and the real stdout pipe, not an in-memory callback.
#[test]
#[ignore = "subprocess fixture for progress tests"]
fn protocol_child() {
    let fixture = std::env::var("RAGE_INSTALL_UNIT_FIXTURE").unwrap();
    let fixture: Value = serde_json::from_str(&fixture).unwrap();
    let result = request(fixture["op"].as_str().unwrap(), &fixture["args"]);
    if let Some(msg) = fixture["error"].as_str() {
        assert!(result.unwrap_err().contains(msg));
    } else {
        result.unwrap();
    }
}

fn frames(op: &str, a: &Value, mut observe: impl FnMut(&Value)) -> Vec<Value> {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "install::tests::protocol_child",
            "--nocapture",
        ])
        .env(
            "RAGE_INSTALL_UNIT_FIXTURE",
            json!({"op":op,"args":a}).to_string(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut rows = Vec::new();
    for line in BufReader::new(child.stdout.take().unwrap()).lines() {
        let line = line.unwrap();
        if let Some(i) = line.find('{') {
            let row: Value = serde_json::from_str(&line[i..]).unwrap();
            observe(&row);
            rows.push(row);
        }
    }
    assert!(child.wait().unwrap().success());
    rows
}

#[test]
fn flushed_progress_reports_real_bytes_mid_transfer_and_retries() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let mut a = args(
        &dir,
        &format!("http://{}/weights", listener.local_addr().unwrap()),
    );
    a["options"]["downloadRetries"] = 2.into();
    a["stream"] = true.into();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        let (mut fail, _) = listener.accept().unwrap();
        read_request(&fail);
        fail.write_all(
            b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
        drop(fail);
        let (mut s, _) = listener.accept().unwrap();
        read_request(&s);
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe")
            .unwrap();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("no progress while transfer is in flight");
        s.write_all(b"llo").unwrap();
    });
    let rows = frames("downloadModel", &a, |row| {
        let p = &row["progress"];
        if p["downloaded"] == 2 {
            assert_eq!(p["total"], 5);
            assert_eq!(p["percent"], 40.0);
            assert_eq!(p["attempt"], 2);
            tx.send(()).unwrap();
        }
    });
    worker.join().unwrap();
    let retry = rows.iter().find_map(|r| r.get("retry")).unwrap();
    assert_eq!(retry["attempt"], 1);
    assert_eq!(retry["attempts"], 2);
    assert_eq!(retry["nextAttempt"], 2);
    assert!(retry["error"].as_str().unwrap().contains("503"));
    assert_eq!(rows.last().unwrap()["progress"]["state"], "done");
    assert_eq!(rows.last().unwrap()["progress"]["downloaded"], 5);
    a["stream"] = false.into();
    assert!(frames("downloadModel", &a, |_| {}).is_empty());
}

#[test]
fn engine_progress_tracks_verified_archive_and_binary_phases_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = args(&dir, "unused");
    registry_fixture(&dir, &mut a, EXE);
    a["stream"] = true.into();
    let rows = frames("installManagedEngine", &a, |_| {});
    let mut states = rows
        .iter()
        .map(|r| r["progress"]["state"].as_str().unwrap())
        .collect::<Vec<_>>();
    states.dedup();
    assert_eq!(
        states,
        [
            "registry",
            "downloading",
            "verifying",
            "decompressing",
            "verifying-binary",
            "probing",
            "done"
        ]
    );
    assert_eq!(rows.last().unwrap()["progress"]["downloaded"], EXE.len());
}

#[test]
fn host_fetch_uses_unix_socket_preserves_range_and_rejects_redirects_and_header_newlines() {
    use std::os::unix::net::UnixListener;
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("transfer.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let worker = thread::spawn(move || {
        for response in [b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/5\r\n\r\nllo".as_slice(),
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/not-used\r\nContent-Length: 0\r\n\r\n"] {
            let (mut c,_) = listener.accept().unwrap();
            let mut request = String::new();
            let mut reader = BufReader::new(&c);
            while !request.ends_with("\r\n\r\n") { assert!(reader.read_line(&mut request).unwrap() > 0); }
            assert!(request.starts_with("GET /transfer HTTP/1.1\r\n"));
            assert!(request.to_ascii_lowercase().contains("x-rage-url: http://127.0.0.1:1/original?x=2\r\n"));
            if response.starts_with(b"HTTP/1.1 206") { assert!(request.to_ascii_lowercase().contains("range: bytes=2-\r\n")); }
            c.write_all(response).unwrap();
        }
    });
    let run = |a: &Value, expected_error: Option<&str>| {
        let out = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "install::tests::protocol_child",
                "--nocapture",
            ])
            .env(
                "RAGE_INSTALL_UNIT_FIXTURE",
                json!({"op":"downloadModel","args":a,"error":expected_error}).to_string(),
            )
            .env("RAGE_HOST_FETCH_SOCKET", &sock)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    let mut a = args(&dir, "http://127.0.0.1:1/original?x=2");
    let models = dir.path().join("models");
    fs::create_dir(&models).unwrap();
    fs::write(models.join("weights.bin.partial"), b"he").unwrap();
    run(&a, None);
    assert_eq!(fs::read(models.join("weights.bin")).unwrap(), b"hello");
    a["model"]["filename"] = "other.bin".into();
    run(&a, Some("unsuccessful HTTP response"));
    worker.join().unwrap();
    a["model"]["url"] = "http://127.0.0.1:1/x\r\nX-Extra: nope".into();
    run(&a, Some("newline"));
    assert!(!models.join("other.bin").exists());
}
