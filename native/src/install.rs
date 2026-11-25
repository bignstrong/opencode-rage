//! macOS managed assets. Paths and catalog records come from the shared catalog.
//! Cancellation: create `args.cancelFile`; the running child is killed and reaped.
//! `stream: true` opts into flushed NDJSON progress/retry frames. The CLI owns the result frame.
use serde_json::{Value, json};
use std::error::Error;
use std::fs::{self, File};
use std::io::{self, Read, Seek, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use tempfile::{NamedTempFile, TempDir};

type R<T> = Result<T, Box<dyn Error>>;
const MIB: u64 = 1 << 20;
const REGISTRY: &str =
    "https://github.com/bignstrong/opencode-rage/releases/download/engines-v1/registry.json";
const REGISTRY_PIN: &str = "d2d7dd0f4921f20fb52d00078c2b0250f31e655aa182a9a983f7d53c55e4b406";

fn text<'a>(v: &'a Value, key: &str) -> R<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {key}").into())
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn too_large() -> Box<dyn Error> {
    io::Error::new(io::ErrorKind::FileTooLarge, "Asset exceeds size limit").into()
}
fn size_error(e: &(dyn Error + 'static)) -> bool {
    e.downcast_ref::<io::Error>()
        .is_some_and(|e| e.kind() == io::ErrorKind::FileTooLarge)
}
fn suffix(path: &Path, s: &str) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(s);
    p.into()
}
fn cancel(a: &Value) -> R<()> {
    if let Some(p) = a["cancelFile"].as_str()
        && Path::new(p).try_exists()?
    {
        return Err("Installation canceled".into());
    }
    Ok(())
}
#[derive(Clone, Copy)]
struct Attempt {
    n: usize,
    total: usize,
}
impl Attempt {
    fn progress(self, a: &Value, state: &str, bytes: u64, total: u64) -> R<()> {
        if a["stream"] == true {
            let percent = if total == 0 {
                0.0
            } else {
                bytes as f64 * 100.0 / total as f64
            };
            frame(
                json!({"progress":{"state":state,"downloaded":bytes,"total":total,"percent":percent,"attempt":self.n,"attempts":self.total}}),
            )?;
        }
        Ok(())
    }
    fn retry(self, a: &Value, error: &str) -> R<()> {
        if self.n >= self.total {
            return Ok(());
        }
        if a["stream"] == true {
            frame(
                json!({"retry":{"error":error,"attempt":self.n,"attempts":self.total,"nextAttempt":self.n+1}}),
            )?;
        }
        let until = Instant::now() + Duration::from_millis((self.n as u64 * 1_000).min(3000));
        while Instant::now() < until {
            cancel(a)?;
            std::thread::sleep(
                Duration::from_millis(20).min(until.saturating_duration_since(Instant::now())),
            );
        }
        Ok(())
    }
}
fn frame(v: Value) -> R<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{v}")?;
    Ok(out.flush()?)
}
fn remove_file(path: &Path) -> R<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => Ok(r?),
    }
}
fn cache(a: &Value) -> R<PathBuf> {
    Ok(PathBuf::from(
        crate::catalog::request("getCacheDir", a)?
            .as_str()
            .ok_or("Invalid cache directory")?,
    ))
}

// Never follow a symlink introduced inside the configured cache for a write/remove.
fn subdir(root: &Path, name: &str, create: bool) -> R<PathBuf> {
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(m) if !m.is_dir() => {
            return Err(format!("Not a cache directory: {}", path.display()).into());
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if create {
                fs::create_dir_all(&path)?;
            }
        }
        Err(e) => return Err(e.into()),
        _ => {}
    }
    Ok(path)
}
fn copy_bounded(src: impl Read, dst: impl Write, max: u64, a: &Value) -> R<u64> {
    copy_progress(src, dst, max, a, |_| Ok(()))
}
fn copy_progress(
    mut src: impl Read,
    mut dst: impl Write,
    max: u64,
    a: &Value,
    mut progress: impl FnMut(u64) -> R<()>,
) -> R<u64> {
    let mut buf = [0; 64 * 1024];
    let mut total = 0;
    loop {
        cancel(a)?;
        let n = src.read(&mut buf)?;
        if n == 0 {
            return Ok(total);
        }
        total += n as u64;
        if total > max {
            return Err(too_large());
        }
        dst.write_all(&buf[..n])?;
        progress(total)?;
    }
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn wait(
    child: &mut Running,
    a: &Value,
    timeout: Duration,
    out: &File,
    max: u64,
    mut progress: impl FnMut(u64) -> R<()>,
) -> R<ExitStatus> {
    let start = Instant::now();
    loop {
        cancel(a)?;
        let len = out.metadata()?.len();
        if len > max {
            return Err(too_large());
        }
        progress(len)?;
        if let Some(exit) = child.0.try_wait()? {
            return Ok(exit);
        }
        if start.elapsed() >= timeout {
            return Err("Operation timed out".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
// Pipe through a bounded copier: chunked HTTP bodies and gzip expansion need a
// hard byte limit even on older macOS curl releases.
fn stream(
    cmd: &mut Command,
    dst: &File,
    max: u64,
    a: &Value,
    mut progress: impl FnMut(u64) -> R<()>,
) -> R<()> {
    cancel(a)?;
    let mut errors = tempfile::tempfile()?;
    let mut proc = Running(
        cmd.stdout(Stdio::piped())
            .stderr(errors.try_clone()?)
            .spawn()?,
    );
    let stdout = proc.0.stdout.take().ok_or("Missing command output")?;
    let mut output = dst.try_clone()?;
    let copy = std::thread::spawn(move || io::copy(&mut stdout.take(max + 1), &mut output));
    let result = wait(
        &mut proc,
        a,
        Duration::from_secs(6 * 3600),
        dst,
        max,
        &mut progress,
    );
    drop(proc);
    let n = copy.join().map_err(|_| "File copy failed")??;
    if n > max {
        return Err(too_large());
    }
    let exit = result?;
    progress(n)?;
    if cmd.get_program() == "/usr/bin/curl" && exit.code() == Some(63) {
        return Err(
            io::Error::new(io::ErrorKind::FileTooLarge, "Download exceeds size limit").into(),
        );
    }
    if cmd.get_program() == "/usr/bin/curl" && exit.code() == Some(18) {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Download incomplete").into());
    }
    if !exit.success() {
        errors.rewind()?;
        let mut detail = String::new();
        errors.take(2048).read_to_string(&mut detail)?;
        return Err(format!("Command failed: {}", detail.trim()).into());
    }
    Ok(())
}
fn digest(file: &File, a: &Value) -> R<String> {
    let mut input = file.try_clone()?;
    input.rewind()?;
    let mut out = tempfile::tempfile()?;
    stream(
        Command::new("/usr/bin/openssl")
            .args(["dgst", "-sha256", "-r"])
            .stdin(input),
        &out,
        256,
        a,
        |_| Ok(()),
    )?;
    out.rewind()?;
    let mut result = String::new();
    out.read_to_string(&mut result)?;
    Ok(result
        .split_whitespace()
        .next()
        .filter(|s| valid_hash(s))
        .ok_or("Invalid SHA256 result")?
        .into())
}
fn headers(path: &Path) -> R<(u16, String, u64)> {
    let mut bytes = Vec::new();
    File::open(path)?.take(MIB + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MIB as usize {
        return Err("Response headers exceed size limit".into());
    }
    let text = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
    let block = text
        .rsplit("\n\n")
        .find(|s| s.starts_with("HTTP/"))
        .unwrap_or("");
    let code = block
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let range = block
        .lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-range"))
        .map(|(_, v)| v.trim().into())
        .unwrap_or_default();
    let length = block
        .lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse().ok())
        .unwrap_or(0);
    Ok((code, range, length))
}
fn http(
    url: &str,
    dst: &File,
    max: u64,
    a: &Value,
    range: u64,
    hdr: &Path,
    events: Option<(Attempt, u64)>,
) -> R<()> {
    let protocols = if url.starts_with("https://") {
        "=https"
    } else if url.starts_with("http://") {
        "=http,https"
    } else {
        return Err("Expected an HTTP(S) URL".into());
    };
    let socket = std::env::var_os("RAGE_HOST_FETCH_SOCKET");
    let protocols = if socket.is_some() { "=http" } else { protocols };
    let timeout = a["options"]["engineDownloadTimeoutMs"]
        .as_u64()
        .or_else(|| a["options"]["downloadTimeoutMs"].as_u64())
        .unwrap_or(120_000)
        .clamp(1, 3_600_000)
        .div_ceil(1000)
        .to_string();
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args([
        "--disable",
        "--globoff",
        "--no-buffer",
        "--silent",
        "--show-error",
        "--fail",
        "--proto",
        protocols,
        "--proto-redir",
        protocols,
        "--connect-timeout",
        &timeout,
        "--speed-limit",
        "1",
        "--speed-time",
        &timeout,
        "--max-filesize",
        &max.to_string(),
        "--dump-header",
    ])
    .arg(hdr);
    let destination = if let Some(socket) = socket.as_ref() {
        if url.contains(['\r', '\n']) {
            return Err("Invalid newline in host fetch URL".into());
        }
        if socket.is_empty() {
            return Err("Empty host fetch socket path".into());
        }
        cmd.args(["--noproxy", "*", "--unix-socket"])
            .arg(socket)
            .args(["--header", &format!("X-Rage-Url: {url}")]);
        "http://localhost/transfer"
    } else {
        cmd.args(["--location", "--max-redirs", "12"]);
        url
    };
    if range > 0 {
        cmd.args(["--range", &format!("{range}-")]);
    }
    let mut response = None;
    let mut reported = None;
    stream(
        cmd.arg("--").arg(destination).stdin(Stdio::null()),
        dst,
        max,
        a,
        |bytes| {
            if a["stream"] != true {
                return Ok(());
            }
            let Some((attempt, hint)) = events else {
                return Ok(());
            };
            if response.is_none() {
                let (status, content_range, length) = headers(hdr)?;
                if matches!(status, 200 | 206) {
                    let base = if status == 206 { range } else { 0 };
                    let total = content_range
                        .rsplit_once('/')
                        .and_then(|(_, n)| n.parse().ok())
                        .unwrap_or_else(|| {
                            if length > 0 {
                                length.saturating_add(base)
                            } else {
                                hint
                            }
                        });
                    response = Some((base, total));
                }
            }
            let (base, total) = response.unwrap_or((range, hint));
            let point = (bytes.saturating_add(base), total);
            if reported != Some(point) {
                attempt.progress(a, "downloading", point.0, point.1)?;
                reported = Some(point);
            }
            Ok(())
        },
    )?;
    if socket.is_some() && !(200..300).contains(&headers(hdr)?.0) {
        return Err("Host fetch returned an unsuccessful HTTP response".into());
    }
    Ok(())
}
fn local_path(url: &str) -> R<PathBuf> {
    if let Some(s) = url.strip_prefix("file://") {
        if !s.starts_with('/') {
            return Err("Expected an absolute local file URL".into());
        }
        let mut it = s.bytes();
        let mut buf = Vec::new();
        while let Some(b) = it.next() {
            buf.push(if b == b'%' {
                let mut digit = || {
                    it.next()
                        .and_then(|d| (d as char).to_digit(16))
                        .ok_or("Invalid file URL")
                };
                (digit()? * 16 + digit()?) as u8
            } else {
                b
            });
        }
        Ok(String::from_utf8(buf)?.into())
    } else if url.contains("://") {
        Err("Unsupported asset URL".into())
    } else {
        Ok(std::path::absolute(url)?)
    }
}
fn fetch(url: &str, dst: &File, max: u64, a: &Value, events: Option<(Attempt, u64)>) -> R<()> {
    if url.starts_with("http://") || url.starts_with("https://") {
        let hdr = NamedTempFile::new()?;
        http(url, dst, max, a, 0, hdr.path(), events)
    } else {
        let f = File::open(local_path(url)?)?;
        let total = f.metadata()?.len();
        if let Some((ev, _)) = events {
            ev.progress(a, "downloading", 0, total)?;
        }
        copy_progress(f, dst, max, a, |n| {
            if let Some((ev, _)) = events {
                ev.progress(a, "downloading", n, total)
            } else {
                Ok(())
            }
        })?;
        Ok(())
    }
}
fn stamp(sha: &str, m: &fs::Metadata) -> R<String> {
    let ns = |s: i64, n: i64| (i128::from(s) * 1_000_000_000 + i128::from(n)).to_string();
    let stat = json!({"dev":m.dev(),"ino":m.ino(),"size":m.len(),"mtimeNs":ns(m.mtime(),m.mtime_nsec()),"ctimeNs":ns(m.ctime(),m.ctime_nsec())});
    Ok(
        crate::catalog::request("modelVerificationStamp", &json!({"digest":sha,"stat":stat}))?
            .as_str()
            .ok_or("Invalid model stamp")?
            .into(),
    )
}
fn verified(file: &File, sha: &str, limit: u64, a: &Value) -> R<Option<fs::Metadata>> {
    let before = file.metadata()?;
    Ok((before.is_file()
        && before.len() > 0
        && before.len() <= limit
        && digest(file, a)? == sha
        && stamp(sha, &before)? == stamp(sha, &file.metadata()?)?)
    .then_some(before))
}
fn receipt(stat: &fs::Metadata, dest: &Path, sha: &str) -> R<()> {
    let mut marker = NamedTempFile::new_in(dest.parent().ok_or("Missing model directory")?)?;
    writeln!(marker, "{}", stamp(sha, stat)?)?;
    marker.persist(suffix(dest, ".sha256"))?;
    Ok(())
}

fn range_ok(value: &str, offset: u64, max: u64) -> bool {
    let Some((span, total)) = value.strip_prefix("bytes ").and_then(|s| s.split_once('/')) else {
        return false;
    };
    let Some((start, end)) = span.split_once('-') else {
        return false;
    };
    start.parse::<u64>() == Ok(offset)
        && end.parse::<u64>().is_ok_and(|n| n >= offset && n < max)
        && (total == "*" || total.parse::<u64>().is_ok_and(|n| n <= max))
}

fn model(a: &Value, op: &str) -> R<Value> {
    let m = if a["model"].is_object() {
        a["model"].clone()
    } else {
        crate::catalog::request("selectModel", a)?
    };
    let name = text(&m, "filename")?;
    if Path::new(name).file_name().and_then(|s| s.to_str()) != Some(name)
        || !name.ends_with(".bin") && !name.ends_with(".gguf")
    {
        return Err("Invalid model filename".into());
    }
    let sha = text(&m, "sha256")?;
    let size = m["sizeMB"].as_f64().unwrap_or_default();
    let limit = ((size * 1.15 + 1.0) * MIB as f64).ceil();
    if !valid_hash(sha) || size <= 0.0 || limit > (1u64 << 53) as f64 {
        return Err("Invalid model digest or size".into());
    }
    let max = limit as u64;
    let dir = subdir(
        &cache(a)?,
        "models",
        matches!(op, "downloadModel" | "importModel"),
    )?;
    let dest = dir.join(name);
    let checkpoint = suffix(&dest, ".partial");
    if op == "removeModel" {
        for p in [&dest, &suffix(&dest, ".sha256"), &checkpoint] {
            remove_file(p)?;
        }
        return Ok(json!(dest));
    }
    if op == "verifyModel" {
        let file = File::open(a["file"].as_str().map(Path::new).unwrap_or(&dest))?;
        return Ok(json!(verified(&file, sha, max, a)?.is_some()));
    }
    if m["implemented"] != true {
        return Err("Unavailable model".into());
    }
    let mut event = Attempt {
        n: 1,
        total: a["options"]["downloadRetries"]
            .as_u64()
            .unwrap_or(5)
            .clamp(1, 20) as usize,
    };
    if op == "downloadModel" && fs::symlink_metadata(&dest).is_ok_and(|m| m.is_file()) {
        let file = File::open(&dest)?;
        let bytes = file.metadata()?.len();
        event.progress(a, "verifying", bytes, bytes)?;
        if let Some(stat) = verified(&file, sha, max, a)? {
            receipt(&stat, &dest, sha)?;
            return Ok(json!(dest));
        }
    }
    let stage = private_stage(&dir, ".model-")?;
    let part = stage.path().join("partial");
    if op == "importModel" {
        let path = text(a, "sourcePath")?;
        if !fs::metadata(path)?.is_file() {
            return Err("Expected a model file".into());
        }
        let source = File::open(path)?;
        copy_bounded(source, File::create_new(&part)?, max, a)?;
    } else {
        let mut urls = Vec::new();
        for url in m["urls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .chain([text(&m, "url")?])
        {
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
        let claim = stage.path().join("checkpoint");
        if fs::symlink_metadata(&checkpoint).is_ok_and(|m| m.is_file())
            && fs::rename(&checkpoint, &claim).is_ok()
            && fs::symlink_metadata(&claim)?.is_file()
            && fs::metadata(&claim)?.len() <= max
        {
            copy_bounded(File::open(&claim)?, File::create_new(&part)?, max, a)?;
        }
        event.total = event.total.max(urls.len());
        let mut problem = String::new();
        for n in 0..event.total {
            cancel(a)?;
            event.n = n + 1;
            let url = urls[n % urls.len()];
            let attempt = || -> R<()> {
                let mut offset = fs::metadata(&part).map_or(0, |m| m.len());
                loop {
                    let response = NamedTempFile::new_in(stage.path())?;
                    let hdr = NamedTempFile::new_in(stage.path())?;
                    let transfer = http(
                        url,
                        response.as_file(),
                        max,
                        a,
                        offset,
                        hdr.path(),
                        Some((event, 0)),
                    );
                    let (status, range, _) = headers(hdr.path())?;
                    if status == 416 && offset != 0 {
                        remove_file(&part)?;
                        offset = 0;
                        continue;
                    }
                    let len = response.as_file().metadata()?.len();
                    if len > max
                        || transfer.as_ref().is_err_and(|e| size_error(e.as_ref()))
                        || status == 206
                            && (len > max - offset
                                || range
                                    .rsplit_once('/')
                                    .and_then(|(_, n)| n.parse::<u64>().ok())
                                    .is_some_and(|n| n > max))
                    {
                        remove_file(&part)?;
                        return Err(
                            format!("Model download exceeds size limit of {max} bytes").into()
                        );
                    }
                    if status == 206 && !range_ok(&range, offset, max) {
                        remove_file(&part)?;
                        return Err(format!("Download resume mismatch from {url}: expected byte {offset}, got {range}").into());
                    }
                    if status >= 400 {
                        return Err(format!("Download failed from {url}: HTTP {status}").into());
                    }
                    if status == 206 && offset > 0 {
                        let mut tail = response.reopen()?;
                        tail.rewind()?;
                        copy_bounded(
                            tail,
                            File::options().append(true).open(&part)?,
                            max - offset,
                            a,
                        )?;
                    } else if status == 200 || status == 206 {
                        response.persist(&part)?;
                    }
                    transfer?;
                    if !matches!(status, 200 | 206) {
                        return Err(format!("Unexpected HTTP status {status}").into());
                    }
                    let staged = File::open(&part)?;
                    let bytes = staged.metadata()?.len();
                    event.progress(a, "verifying", bytes, bytes)?;
                    if verified(&staged, sha, max, a)?.is_none() {
                        remove_file(&part)?;
                        return Err(format!("SHA256 mismatch for {name}").into());
                    }
                    return Ok(());
                }
            };
            match attempt() {
                Ok(()) => {
                    problem.clear();
                    break;
                }
                Err(e) => problem = e.to_string(),
            }
            if cancel(a).is_err() {
                break;
            }
            event.retry(a, &problem)?;
        }
        if !problem.is_empty() {
            if fs::metadata(&part).is_ok_and(|m| m.len() > 0 && m.len() <= max) {
                fs::rename(&part, &checkpoint)?;
            }
            return Err(problem.into());
        }
    }
    let file = File::open(&part)?;
    if op == "importModel" && verified(&file, sha, max, a)?.is_none() {
        return Err("Imported model SHA256 mismatch".into());
    }
    cancel(a)?;
    fs::rename(&part, &dest)?;
    // Renaming changes ctime; read the stamp from the verified inode, never the racing pathname.
    receipt(&file.metadata()?, &dest, sha)?;
    if op == "downloadModel" {
        let bytes = file.metadata()?.len();
        event.progress(a, "done", bytes, bytes)?;
    }
    Ok(json!(dest))
}

struct Engine<'a> {
    id: &'a str,
    cmd: &'static str,
    option: &'static str,
    env: &'static str,
    platform: String,
    root: PathBuf,
    parent: PathBuf,
    dir: PathBuf,
    bin: PathBuf,
}
impl<'a> Engine<'a> {
    fn new(a: &'a Value, create: bool) -> R<Self> {
        let id = a["engineId"]
            .as_str()
            .or_else(|| a["id"].as_str())
            .unwrap_or("whisper.cpp");
        let (cmd, option, env) = match id {
            "whisper.cpp" => ("whisper-cli", "whisperCli", "OPENCODE_VOICE_WHISPER_CLI"),
            "transcribe-cpp" => (
                "opencode-voice-transcribe",
                "transcribeCpp",
                "OPENCODE_VOICE_TRANSCRIBE_CPP",
            ),
            _ => return Err(format!("Unsupported engine: {id}").into()),
        };
        if a["options"]["platform"]
            .as_str()
            .is_some_and(|p| p != "darwin")
        {
            return Err("Only macOS engines are supported".into());
        }
        let arch = match a["options"]["arch"]
            .as_str()
            .unwrap_or(std::env::consts::ARCH)
        {
            "x64" | "x86_64" | "amd64" => "x64",
            "arm64" | "aarch64" => "arm64",
            v => return Err(format!("Unsupported macOS architecture: {v}").into()),
        };
        let platform = format!("darwin-{arch}");
        let root = cache(a)?;
        let parent = subdir(&subdir(&root, "engines", create)?, id, create)?;
        let dir = subdir(&parent, &platform, false)?;
        let bin = dir.join(cmd);
        Ok(Self {
            id,
            cmd,
            option,
            env,
            platform,
            root,
            parent,
            dir,
            bin,
        })
    }
    fn manifest(&self) -> Value {
        fs::read(self.dir.join("manifest.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null)
    }
    fn resolve(&self, a: &Value) -> (Option<PathBuf>, &'static str) {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let search: Vec<_> = std::env::split_paths(&path)
            .filter(|d| !d.as_os_str().is_empty())
            .collect();
        let mut candidates = Vec::new();
        for (value, source) in [
            (
                a["options"][self.option].as_str().map(str::to_owned),
                "option",
            ),
            (std::env::var(self.env).ok(), "env"),
        ] {
            if let Some(v) = value.filter(|s| !s.is_empty()) {
                if v.contains('/') {
                    candidates.push((v.into(), source));
                } else {
                    candidates.extend(search.iter().map(|dir| (dir.join(&v), source)));
                }
            }
        }
        candidates.push((self.bin.clone(), "managed"));
        candidates.extend(search.iter().map(|d| (d.join(self.cmd), "system")));
        if let Some(home) = std::env::home_dir() {
            for d in [".local/bin", ".opencode-voice/bin"] {
                candidates.push((home.join(d).join(self.cmd), "system"));
            }
        }
        for d in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"] {
            candidates.push((Path::new(d).join(self.cmd), "system"));
        }
        for (p, src) in candidates {
            if fs::metadata(&p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) {
                let source = if p == self.bin { "managed" } else { src };
                return (Some(p), source);
            }
        }
        (None, "missing")
    }
    fn status(&self, a: &Value) -> Value {
        let (resolved, source) = self.resolve(a);
        json!({"id":self.id,"command":self.cmd,"platform":self.platform,"cacheDir":self.root,"managedDir":self.dir,"managedBinary":self.bin,"managedInstalled":self.bin.exists(),"manifest":self.manifest(),"resolvedBinary":resolved,"source":source})
    }
}
fn registry_url(a: &Value) -> String {
    a["options"]["engineRegistry"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| std::env::var("OPENCODE_VOICE_ENGINE_REGISTRY").ok())
        .unwrap_or_else(|| REGISTRY.into())
}
fn registry(a: &Value) -> R<(String, Value)> {
    let url = registry_url(a);
    let mut file = tempfile::tempfile()?;
    if url.starts_with("http://") {
        return Err("Remote engine registry requires HTTPS".into());
    }
    let pin = if url == REGISTRY {
        Some(REGISTRY_PIN.into())
    } else if url.starts_with("https://") {
        let p = a["options"]["engineRegistrySha256"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| std::env::var("OPENCODE_VOICE_ENGINE_REGISTRY_SHA256").ok());
        Some(
            p.filter(|v| valid_hash(v))
                .ok_or("Custom HTTPS engine registry requires engineRegistrySha256")?,
        )
    } else {
        None
    };
    fetch(&url, &file, MIB, a, None)?;
    if let Some(pin) = pin
        && digest(&file, a)? != pin
    {
        return Err("Engine registry SHA256 mismatch".into());
    }
    file.rewind()?;
    let r: Value = serde_json::from_reader(file)?;
    if r["schema"] != "opencode-voice.engines.v1" {
        return Err("Unsupported engine registry schema".into());
    }
    Ok((url, r))
}
fn probe(p: &Path, a: &Value) -> R<()> {
    let mut log = tempfile::tempfile()?;
    let mut cmd = Command::new(p);
    if let Some(home) = std::env::home_dir() {
        for (key, mut dirs) in [
            (
                "PATH",
                vec![
                    p.parent().unwrap_or(Path::new(".")).to_owned(),
                    home.join(".local/bin"),
                ],
            ),
            ("DYLD_LIBRARY_PATH", vec![home.join(".local/lib")]),
            ("LD_LIBRARY_PATH", vec![home.join(".local/lib")]),
        ] {
            if let Some(old) = std::env::var_os(key) {
                dirs.extend(std::env::split_paths(&old));
            }
            cmd.env(key, std::env::join_paths(dirs)?);
        }
    }
    let mut child = Running(
        cmd.arg("--help")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log.try_clone()?)
            .spawn()?,
    );
    let status = wait(
        &mut child,
        a,
        Duration::from_millis(
            a["options"]["timeoutMs"]
                .as_u64()
                .unwrap_or(10_000)
                .clamp(1, 120_000),
        ),
        &log,
        MIB,
        |_| Ok(()),
    )?;
    log.rewind()?;
    let mut bytes = Vec::new();
    log.take(MIB).read_to_end(&mut bytes)?;
    let help = String::from_utf8_lossy(&bytes);
    if !(help.contains("--model") && help.contains("--file")) {
        return Err(format!(
            "Unexpected engine help ({status}): {}",
            help.chars().take(240).collect::<String>()
        )
        .into());
    }
    Ok(())
}
fn only_managed(e: &Engine) -> R<()> {
    for entry in fs::read_dir(&e.dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if !entry.file_type()?.is_file() || name != e.cmd && name != "manifest.json" {
            return Err(format!(
                "Engine directory contains an active installer or unrecognized file: {}",
                entry.path().display()
            )
            .into());
        }
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn exchange(staged: &Path, installed: &Path) -> R<()> {
    use std::ffi::{CString, c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn renamex_np(old: *const c_char, new: *const c_char, flags: c_uint) -> c_int;
    }
    let old = CString::new(staged.as_os_str().as_bytes())?;
    let new = CString::new(installed.as_os_str().as_bytes())?;
    // Darwin RENAME_SWAP atomically exchanges both complete directories on one volume.
    // SAFETY: both NUL-terminated paths remain alive for the duration of this call.
    if unsafe { renamex_np(old.as_ptr(), new.as_ptr(), 2) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn exchange(_: &Path, _: &Path) -> R<()> {
    Err("Atomic engine replacement requires macOS".into())
}

fn installed_at() -> R<String> {
    let date = Command::new("/bin/date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%S.000Z"])
        .output()?;
    if !date.status.success() {
        return Err("Cannot stamp engine installation date".into());
    }
    Ok(String::from_utf8(date.stdout)?.trim().into())
}
fn publish(e: &Engine, staged: &TempDir, source: Value, sha: &str, a: &Value) -> R<Value> {
    let size = fs::metadata(staged.path().join(e.cmd))?.len();
    let manifest = json!({"schema":"opencode-voice.engine-install.v1","id":e.id,"kind":"cli","command":e.cmd,"platform":e.platform,"version":source["version"].as_str().unwrap_or("local-import"),"source":source,"files":[{"path":e.cmd,"sha256":sha,"size":size}],"installedAt":installed_at()?});
    let mut out = File::create_new(staged.path().join("manifest.json"))?;
    serde_json::to_writer_pretty(&mut out, &manifest)?;
    out.write_all(b"\n")?;
    out.sync_all()?;
    let lock = File::open(&e.parent)?;
    lock.try_lock()
        .map_err(|_| "Another engine installation owns the cache")?;
    cancel(a)?;
    if e.dir.try_exists()? {
        only_managed(e)?;
        exchange(staged.path(), &e.dir)?;
    } else {
        fs::rename(staged.path(), &e.dir)?;
    }
    Ok(json!({"manifest":manifest,"managedBinary":e.bin}))
}
fn download_engine(e: &Engine, a: &Value) -> R<Value> {
    if !a["force"].as_bool().unwrap_or(false) && e.bin.is_file() && probe(&e.bin, a).is_ok() {
        return Ok(json!({"manifest":e.manifest(),"managedBinary":e.bin,"skipped":true}));
    }
    Attempt { n: 1, total: 1 }.progress(a, "registry", 0, 0)?;
    let (url, r) = registry(a)?;
    let def = if let Some(list) = r["engines"].as_array() {
        list.iter()
            .find(|v| v["id"] == e.id)
            .ok_or("Engine not found in registry")?
    } else {
        &r["engines"][e.id]
    };
    let asset = &def["assets"][&e.platform];
    if asset.is_null() {
        return Err(format!("No managed {} engine asset for {}", e.id, e.platform).into());
    }
    if asset["kind"] != "single-binary-gzip" {
        return Err("Unsupported engine asset kind".into());
    }
    let required = "Engine registry must provide archive and binary SHA256 digests";
    let archive_sha = asset["sha256"]
        .as_str()
        .filter(|s| valid_hash(s))
        .ok_or(required)?;
    let binary_sha = asset["binary"]["sha256"]
        .as_str()
        .filter(|s| valid_hash(s))
        .ok_or(required)?;
    let asset_url = text(asset, "url")?;
    if url.starts_with("https://") && !asset_url.starts_with("https://") {
        return Err("Remote engine registry requires HTTPS assets".into());
    }
    let bound = |v: &Value, fallback| {
        v["size"]
            .as_u64()
            .filter(|n| *n > 0 && *n < (1u64 << 53))
            .unwrap_or(fallback)
    };
    let attempts = a["options"]["engineDownloadRetries"]
        .as_u64()
        .unwrap_or(5)
        .clamp(1, 20) as usize;
    for n in 1..=attempts {
        cancel(a)?;
        let event = Attempt { n, total: attempts };
        let stage = private_stage(&e.parent, ".install-")?;
        let mut archive = tempfile::tempfile_in(&e.parent)?;
        let path = stage.path().join(e.cmd);
        let attempt = || -> R<()> {
            fetch(
                asset_url,
                &archive,
                bound(asset, 256 * MIB),
                a,
                Some((event, bound(asset, 0))),
            )
            .map_err(|e| {
                if size_error(e.as_ref()) {
                    "Engine archive exceeds size limit".into()
                } else {
                    e
                }
            })?;
            let archive_size = archive.metadata()?.len();
            event.progress(a, "verifying", archive_size, archive_size)?;
            if digest(&archive, a)? != archive_sha {
                return Err("Engine archive SHA256 mismatch".into());
            }
            archive.rewind()?;
            event.progress(a, "decompressing", archive_size, archive_size)?;
            let file = File::options()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&path)?;
            stream(
                Command::new("/usr/bin/gzip")
                    .arg("-dc")
                    .stdin(archive.try_clone()?),
                &file,
                bound(&asset["binary"], 512 * MIB),
                a,
                |_| Ok(()),
            )
            .map_err(|e| {
                if size_error(e.as_ref()) {
                    "Engine binary exceeds size limit".into()
                } else {
                    e
                }
            })?;
            let bytes = file.metadata()?.len();
            event.progress(a, "verifying-binary", bytes, bytes)?;
            if digest(&file, a)? != binary_sha {
                return Err("Engine binary SHA256 mismatch".into());
            }
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
            file.sync_all()?;
            drop(file);
            event.progress(a, "probing", bytes, bytes)?;
            probe(&path, a).map_err(|e| format!("Engine probe failed: {e}").into())
        }();
        if let Err(error) = attempt {
            if n == attempts {
                return Err(error);
            }
            cancel(a)?;
            event.retry(a, &error.to_string())?;
            continue;
        }
        let mut source = json!({"type":"registry","registry":url,"url":asset_url,"version":def["version"].as_str().or_else(|| r["version"].as_str()).unwrap_or("registry")});
        if let Some(v) = def.get("upstream") {
            source["upstream"] = v.clone();
        }
        let mut result = publish(e, &stage, source, binary_sha, a)?;
        result["skipped"] = false.into();
        let bytes = result["manifest"]["files"][0]["size"].as_u64().unwrap_or(0);
        event.progress(a, "done", bytes, bytes)?;
        return Ok(result);
    }
    Err("Engine installation failed".into())
}
fn private_stage(dir: &Path, prefix: &str) -> R<TempDir> {
    Ok(tempfile::Builder::new()
        .prefix(prefix)
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(dir)?)
}
fn run(op: &str, a: &Value) -> R<Value> {
    cancel(a)?;
    match op {
        "sha256" => return Ok(json!(digest(&File::open(text(a, "file")?)?, a)?)),
        "verifyModel" if a["file"].is_string() => {
            let Some(sha) = a["model"]["sha256"].as_str().filter(|s| !s.is_empty()) else {
                return Ok(true.into());
            };
            return Ok(json!(digest(&File::open(text(a, "file")?)?, a)? == sha));
        }
        "downloadModel" | "importModel" | "verifyModel" | "removeModel" => return model(a, op),
        "getEngineRegistryUrl" => return Ok(json!(registry_url(a))),
        "loadEngineRegistry" => {
            let (url, registry) = registry(a)?;
            return Ok(json!({"url":url,"registry":registry}));
        }
        _ => {}
    }
    let e = Engine::new(
        a,
        matches!(op, "installManagedEngine" | "importManagedEngine"),
    )?;
    match op {
        "getEngineStatus" => Ok(e.status(a)),
        "getEnginePlatformKey" => Ok(json!(e.platform)),
        "getManagedEngineDir" => Ok(json!(e.dir)),
        "getManagedEngineBinary" => Ok(json!(e.bin)),
        "getEngineManifestPath" => Ok(json!(e.dir.join("manifest.json"))),
        "readEngineManifest" => Ok(e.manifest()),
        "probeEngine" => Ok(
            match text(a, "binaryPath").and_then(|p| probe(Path::new(p), a)) {
                Ok(()) => json!({"ok":true,"message":"ok"}),
                Err(e) => json!({"ok":false,"message":e.to_string()}),
            },
        ),
        "installManagedEngine" => download_engine(&e, a),
        "importManagedEngine" => {
            let raw = text(a, "sourcePath")?;
            let expanded = crate::catalog::request("expandHome", &json!({"value":raw}))?;
            let source = std::path::absolute(expanded.as_str().ok_or("Invalid import path")?)?;
            if !fs::metadata(&source)?.is_file() {
                return Err("Expected an engine binary file".into());
            }
            let input = File::open(&source)?;
            let stage = private_stage(&e.parent, ".install-")?;
            let path = stage.path().join(e.cmd);
            let file = File::create_new(&path)?;
            copy_bounded(input, &file, 512 * MIB, a)?;
            file.sync_all()?;
            drop(file);
            let sha = digest(&File::open(&path)?, a)?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
            probe(&path, a).map_err(|e| format!("Imported binary failed probe: {e}"))?;
            publish(
                &e,
                &stage,
                json!({"type":"local-file","path":source}),
                &sha,
                a,
            )
        }
        "removeManagedEngine" => {
            if e.dir.try_exists()? {
                let lock = File::open(&e.parent)?;
                lock.try_lock()
                    .map_err(|_| "Another engine installation owns the cache")?;
                only_managed(&e)?;
                let retired = private_stage(&e.parent, ".remove-")?;
                fs::rename(&e.dir, retired.path().join("retired"))?;
            }
            Ok(json!(e.dir))
        }
        _ => Err(format!("Unknown install operation: {op}").into()),
    }
}

pub fn request(op: &str, args: &Value) -> Result<Value, String> {
    run(op, args).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
