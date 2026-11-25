//! macOS recorder management. The managed ffmpeg-static download is Windows-only;
//! on macOS the legacy contract is discovery, with the package binary as last resort.
use serde_json::{Value, json};
use std::env;
use std::ffi::CString;
use std::fs;
use std::io::{self, Read, Seek};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

type R<T> = Result<T, String>;
const MAX_PROBE: u64 = 1024 * 1024;

fn nonempty<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v[k].as_str().filter(|s| !s.is_empty())
}
fn absolute(p: &Path) -> R<PathBuf> {
    // JS path.resolve is lexical (no symlink traversal or requirement that the file exist).
    let path = std::path::absolute(p).map_err(|e| e.to_string())?;
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    Ok(out)
}
fn executable(p: &Path) -> bool {
    unsafe extern "C" {
        fn access(path: *const std::ffi::c_char, mode: std::ffi::c_int) -> std::ffi::c_int;
    }
    let Ok(name) = CString::new(p.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: name is NUL-terminated and lives through access(2); X_OK checks the caller's permissions.
    (unsafe { access(name.as_ptr(), 1) } == 0) && p.is_file()
}
struct Lookup<'a> {
    args: &'a Value,
    cache: PathBuf,
    raw_arch: &'a str,
}
impl<'a> Lookup<'a> {
    fn new(args: &'a Value) -> R<Self> {
        let options = &args["options"];
        if nonempty(options, "platform").is_some_and(|s| s != "darwin") {
            return Err("Recorder lookup requires macOS".into());
        }
        let raw_arch = nonempty(options, "arch").unwrap_or(if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        });
        if !raw_arch
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            return Err("Invalid recorder architecture".into());
        }
        let cache = crate::catalog::request("getCacheDir", args)?;
        Ok(Self {
            args,
            cache: PathBuf::from(cache.as_str().ok_or("Invalid cache directory")?),
            raw_arch,
        })
    }
    fn platform(&self) -> String {
        format!(
            "darwin-{}",
            match self.raw_arch {
                "amd64" => "x64",
                "x86" => "ia32",
                "aarch64" => "arm64",
                s => s,
            }
        )
    }
    fn recorder_dir(&self) -> PathBuf {
        self.cache
            .join("recorders/ffmpeg-static")
            .join(self.platform())
    }
    fn engine_dir(&self, cmd: &str) -> Option<PathBuf> {
        let id = match cmd {
            "whisper-cli" => "whisper.cpp",
            "opencode-voice-transcribe" => "transcribe-cpp",
            _ => return None,
        };
        Some(
            self.cache
                .join("engines")
                .join(id)
                .join(format!("darwin-{}", self.raw_arch)),
        )
    }
    fn candidates(&self, cmd: &str) -> R<Vec<PathBuf>> {
        if cmd.is_empty() {
            return Ok(Vec::new());
        }
        let mut names = Vec::<PathBuf>::new();
        let override_keys = match cmd {
            "ffmpeg" => Some(("ffmpeg", "OPENCODE_VOICE_FFMPEG")),
            "whisper-cli" => Some(("whisperCli", "OPENCODE_VOICE_WHISPER_CLI")),
            "opencode-voice-transcribe" => Some(("transcribeCpp", "OPENCODE_VOICE_TRANSCRIBE_CPP")),
            _ => None,
        };
        if let Some((option, key)) = override_keys {
            if let Some(path) = nonempty(&self.args["options"], option) {
                names.push(path.into());
            }
            if let Some(path) = env::var_os(key).filter(|s| !s.is_empty()) {
                names.push(path.into());
            }
        }
        if let Some(dir) = self.engine_dir(cmd) {
            names.push(dir.join(cmd));
        }
        names.push(cmd.into());
        let relative = cmd.trim_start_matches('/');
        if let Some(home) = env::home_dir() {
            for dir in [".local/bin", ".opencode-voice/bin"] {
                names.push(home.join(dir).join(relative));
            }
        }
        for dir in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"] {
            names.push(Path::new(dir).join(relative));
        }
        if cmd == "ffmpeg"
            && let Some(bundled) = self.args["bundled"].as_array()
        {
            names.extend(
                bundled
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from),
            );
        }
        let path = env::var_os("PATH").unwrap_or_default();
        let dirs: Vec<_> = env::split_paths(&path)
            .filter(|p| !p.as_os_str().is_empty())
            .collect();
        let mut paths = Vec::new();
        let mut add = |p: &Path| -> R<()> {
            let p = absolute(p)?;
            if !paths.contains(&p) {
                paths.push(p);
            }
            Ok(())
        };
        for name in names {
            if name
                .as_os_str()
                .as_bytes()
                .iter()
                .any(|b| b"/\\".contains(b))
            {
                add(&name)?;
            } else {
                for dir in &dirs {
                    add(&dir.join(&name))?;
                }
            }
        }
        Ok(paths)
    }
    fn accessible(&self, p: &Path) -> bool {
        // An embedder can expose a virtual filesystem. Accept observations only
        // for paths already chosen by the native resolver; never use them to run a probe.
        if let Some(files) = self.args["accessible"].as_array() {
            return files
                .iter()
                .filter_map(Value::as_str)
                .any(|s| Path::new(s) == p);
        }
        executable(p)
    }
    fn resolve(&self, cmd: &str) -> R<Option<PathBuf>> {
        Ok(self
            .candidates(cmd)?
            .into_iter()
            .find(|p| self.accessible(p)))
    }
    fn manifest(&self) -> Value {
        let read = || -> Option<Value> {
            let mut bytes = Vec::new();
            fs::File::open(self.recorder_dir().join("manifest.json"))
                .ok()?
                .take(MAX_PROBE + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() as u64 > MAX_PROBE {
                return None;
            }
            serde_json::from_slice(&bytes).ok()
        };
        read().unwrap_or(Value::Null)
    }
    fn status(&self) -> R<Value> {
        let dir = self.recorder_dir();
        let binary = dir.join("ffmpeg");
        let resolved = self.resolve("ffmpeg")?;
        let source = match resolved.as_deref() {
            None => "missing",
            Some(p) if p == binary => "managed",
            _ => "system-or-bundled",
        };
        Ok(
            json!({"id":"ffmpeg","command":"ffmpeg","platform":self.platform(),"supported":false,"managedDir":dir,
            "managedBinary":binary,"managedInstalled":self.accessible(&binary),"manifest":self.manifest(),"resolvedBinary":resolved,"source":source}),
        )
    }
}
struct ProbeChild(Child);
impl Drop for ProbeChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn failure(message: impl Into<String>) -> Value {
    json!({"ok":false,"message":message.into()})
}
fn probe(a: &Value) -> io::Result<Value> {
    let Some(binary) = nonempty(a, "binaryPath") else {
        return Ok(failure("missing binary"));
    };
    let options = &a["options"];
    let timeout = Duration::from_millis(
        options["timeoutMs"]
            .as_u64()
            .filter(|n| *n != 0)
            .unwrap_or(10_000),
    );
    let mut log = tempfile::tempfile()?;
    let mut cmd = Command::new(binary);
    let parent = Path::new(binary)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut env_path = parent.as_os_str().to_owned();
    if let Some(old) = env::var_os("PATH").filter(|v| !v.is_empty()) {
        env_path.push(":");
        env_path.push(old);
    }
    cmd.env("PATH", env_path);
    if let Some(env) = options["env"].as_object() {
        for (k, v) in env {
            if let Some(v) = v.as_str() {
                cmd.env(k, v);
            }
        }
    }
    let mut child = match cmd
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log.try_clone()?)
        .spawn()
    {
        Ok(p) => ProbeChild(p),
        Err(e) => {
            return Ok(failure(match e.kind() {
                io::ErrorKind::NotFound => format!("spawn {binary} ENOENT"),
                io::ErrorKind::PermissionDenied => format!("spawn {binary} EACCES"),
                _ => e.to_string(),
            }));
        }
    };
    let start = Instant::now();
    let exit = loop {
        if log.metadata()?.len() > MAX_PROBE {
            return Ok(failure("probe output exceeds size limit"));
        }
        if let Some(status) = child.0.try_wait()? {
            break status;
        }
        if start.elapsed() >= timeout {
            return Ok(failure("probe timed out"));
        }
        std::thread::sleep(Duration::from_millis(10).min(timeout.saturating_sub(start.elapsed())));
    };
    log.rewind()?;
    let mut bytes = Vec::new();
    log.take(MAX_PROBE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PROBE {
        return Ok(failure("probe output exceeds size limit"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let version = text.lines().find(|s| !s.is_empty()).unwrap_or("");
    let ok = exit.success() && text.to_ascii_lowercase().contains("ffmpeg version");
    let message = if ok {
        "ok".into()
    } else if let Some(code) = exit.code() {
        format!("unexpected ffmpeg probe output (exit {code})")
    } else {
        "unexpected ffmpeg probe output".into()
    };
    Ok(json!({"ok":ok,"message":message,"versionLine":version}))
}

pub fn request(op: &str, args: &Value) -> R<Value> {
    if op == "probeRecorder" {
        return Ok(probe(args).unwrap_or_else(|e| failure(e.to_string())));
    }
    let lookup = Lookup::new(args)?;
    let command = args["command"].as_str().unwrap_or("ffmpeg");
    let dir = lookup.recorder_dir();
    match op {
        "getManagedRecorderBinary" => Ok(json!(dir.join("ffmpeg"))),
        "getManagedRecorderManifestPath" => Ok(json!(dir.join("manifest.json"))),
        "readManagedRecorderManifest" => Ok(lookup.manifest()),
        "getBundledEngineDir" => Ok(json!(lookup.engine_dir(command).unwrap_or_default())),
        "resolveCommand" => Ok(json!(lookup.resolve(command)?)),
        "commandExists" => Ok(json!(lookup.resolve(command)?.is_some())),
        "recorderCandidates" => Ok(json!(lookup.candidates(command)?)),
        "getRecorderStatus" => lookup.status(),
        "installManagedRecorder" => Err(format!(
            "Managed ffmpeg recorder is only available for Windows, got {}",
            lookup.platform()
        )),
        "ensureManagedRecorder" => {
            let mut status = lookup.status()?;
            status["ok"] = true.into();
            status["skipped"] = true.into();
            status["unsupported"] = true.into();
            Ok(status)
        }
        _ => Err(format!("Unknown recorder operation: {op}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    fn make_bin(p: &Path, script: &str) {
        fs::write(p, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn managed_paths_prefer_settings_and_preserve_distinct_arch_conventions() {
        let dir = tempdir().unwrap();
        let a = json!({"options":{"downloadDir":dir.path().join("ignored"),"arch":"aarch64"},"settings":{"downloadDir":dir.path().join("cache")},"command":"whisper-cli"});
        let binary = dir
            .path()
            .join("cache/recorders/ffmpeg-static/darwin-arm64/ffmpeg");
        assert_eq!(
            request("getManagedRecorderBinary", &a).unwrap(),
            json!(binary)
        );
        assert_eq!(
            request("getBundledEngineDir", &a).unwrap(),
            json!(dir.path().join("cache/engines/whisper.cpp/darwin-aarch64"))
        );
        let m = binary.with_file_name("manifest.json");
        assert_eq!(
            request("getManagedRecorderManifestPath", &a).unwrap(),
            json!(m)
        );
        assert!(
            request("readManagedRecorderManifest", &a)
                .unwrap()
                .is_null()
        );
        fs::create_dir_all(m.parent().unwrap()).unwrap();
        fs::write(&m, r#"{"schema":"legacy","extra":1}"#).unwrap();
        assert_eq!(
            request("readManagedRecorderManifest", &a).unwrap(),
            json!({"schema":"legacy","extra":1})
        );
        fs::write(&m, b"truncated").unwrap();
        assert!(
            request("readManagedRecorderManifest", &a)
                .unwrap()
                .is_null()
        );
    }

    #[test]
    fn ensure_reports_unsupported_without_writing_or_probing() {
        let dir = tempdir().unwrap();
        let fake = dir.path().join("ffmpeg script");
        make_bin(&fake, "exit 19");
        let cache = dir.path().join("not-created");
        let a = json!({"options":{"arch":"amd64","downloadDir":cache,"ffmpeg":fake}});
        let mut expected = request("getRecorderStatus", &a).unwrap();
        assert_eq!(expected["platform"], "darwin-x64");
        assert_eq!(expected["resolvedBinary"], json!(fake));
        assert_eq!(expected["managedInstalled"], false);
        assert_eq!(expected["source"], "system-or-bundled");
        for key in ["ok", "skipped", "unsupported"] {
            expected[key] = true.into();
        }
        assert_eq!(request("ensureManagedRecorder", &a).unwrap(), expected);
        assert_eq!(
            request("installManagedRecorder", &a).unwrap_err(),
            "Managed ffmpeg recorder is only available for Windows, got darwin-x64"
        );
        assert!(!cache.exists());
    }

    #[test]
    fn lookup_checks_executability_then_uses_native_order_and_bundled_fallback() {
        let dir = tempdir().unwrap();
        let fake = dir.path().join("ffmpeg");
        let bundled = dir.path().join("package/ffmpeg");
        let mut a = json!({"options":{"downloadDir":dir.path(),"ffmpeg":fake},"bundled":[bundled]});
        fs::write(&fake, []).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!executable(&fake));
        make_bin(&fake, "exit 1");
        assert_eq!(request("resolveCommand", &a).unwrap(), json!(fake));
        assert_eq!(request("commandExists", &a).unwrap(), true);
        a["accessible"] = json!([bundled]);
        assert_eq!(request("resolveCommand", &a).unwrap(), json!(bundled));
        a["accessible"] = json!([bundled, "/opt/homebrew/bin/ffmpeg"]);
        assert_eq!(
            request("resolveCommand", &a).unwrap(),
            "/opt/homebrew/bin/ffmpeg"
        );
        a["accessible"] = json!([dir.path().join("not-a-candidate")]);
        assert_eq!(request("resolveCommand", &a).unwrap(), Value::Null);
    }

    #[test]
    fn probe_checks_version_exit_code_environment_and_timeout() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("fake ffmpeg");
        let a = json!({"binaryPath":p,"options":{"env":{"TAG":"11"}}});
        assert_eq!(
            request("probeRecorder", &a).unwrap()["message"],
            format!("spawn {} ENOENT", p.display())
        );
        make_bin(
            &p,
            "[ \"$1\" = -version ] || exit 8\nprintf '%s\\r\\n' \"FFmpeg Version $TAG\" >&2",
        );
        assert_eq!(
            request("probeRecorder", &a).unwrap(),
            json!({"ok":true,"message":"ok","versionLine":"FFmpeg Version 11"})
        );
        make_bin(&p, "echo 'ffmpeg version bad'\nexit 9");
        assert_eq!(
            request("probeRecorder", &a).unwrap(),
            json!({"ok":false,"message":"unexpected ffmpeg probe output (exit 9)","versionLine":"ffmpeg version bad"})
        );
        make_bin(&p, "echo 'unrelated tool'");
        assert_eq!(request("probeRecorder", &a).unwrap()["ok"], false);
        make_bin(&p, "exec /bin/sleep 10");
        assert_eq!(
            request(
                "probeRecorder",
                &json!({"binaryPath":p,"options":{"timeoutMs":30}})
            )
            .unwrap(),
            json!({"ok":false,"message":"probe timed out"})
        );
    }
}
