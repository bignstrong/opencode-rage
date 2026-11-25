//! macOS public CLI. The adapter passes argv after the executable name.
use crate::{audio, catalog, install};
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Seek, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HELP: &str = "rage

Usage:
  rage install [--global] [--no-engine]
  rage update [--global]
  rage doctor [--json]
  rage engine status <whisper.cpp|transcribe-cpp> [--json]
  rage engine install <whisper.cpp|transcribe-cpp>
  rage engine import <whisper.cpp|transcribe-cpp> [path-to-binary]
  rage engine remove <whisper.cpp|transcribe-cpp>

Development install from this checkout:
  Add this checkout to the plugins array in ~/.config/opencode/cli.json (V2).
";

fn text(v: &Value, key: &str) -> String {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("missing")
        .into()
}
fn yes(v: bool) -> &'static str {
    if v { "yes" } else { "no" }
}
fn executable(p: &Path) -> bool {
    p.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}
fn recorder_path(name: &str, variables: &[&str]) -> Option<PathBuf> {
    let dirs = env::var_os("PATH")
        .map(|p| {
            env::split_paths(&p)
                .filter(|d| !d.as_os_str().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut candidates = Vec::new();
    for name in variables
        .iter()
        .filter_map(env::var_os)
        .filter(|v| !v.is_empty())
        .chain([name.into()])
    {
        let name = Path::new(&name);
        if name.components().count() > 1 || name.is_absolute() {
            candidates.push(name.to_owned());
        } else {
            candidates.extend(dirs.iter().map(|d| d.join(name)));
        }
    }
    if let Some(home) = env::home_dir() {
        for d in [".local/bin", ".opencode-voice/bin"] {
            candidates.push(home.join(d).join(name));
        }
    }
    for d in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"] {
        candidates.push(Path::new(d).join(name));
    }
    if name == "ffmpeg"
        && let Ok(exe) = env::current_exe()
        && let Some(root) = exe.ancestors().find(|p| p.join("package.json").is_file())
    {
        candidates.push(root.join("node_modules/ffmpeg-static/ffmpeg"));
    }
    candidates
        .into_iter()
        .find(|p| executable(p))
        .and_then(|p| std::path::absolute(p).ok())
}

fn probe_recorder(binary: Option<&Path>, flag: &str) -> Value {
    let Some(bin) = binary else {
        return json!({"ok":false,"message":"missing"});
    };
    let capture = || -> io::Result<Value> {
        let mut out = tempfile::tempfile()?;
        let mut err = tempfile::tempfile()?;
        let mut proc = Command::new(bin)
            .arg(flag)
            .stdin(Stdio::null())
            .stdout(out.try_clone()?)
            .stderr(err.try_clone()?)
            .spawn()?;
        let start = Instant::now();
        let limit = 1024 * 1024;
        let status = loop {
            let over = out.metadata()?.len() + err.metadata()?.len() > limit;
            if over || start.elapsed() >= Duration::from_secs(2) {
                let _ = proc.kill();
                proc.wait()?;
                let reason = if over { "ENOBUFS" } else { "ETIMEDOUT" };
                return Ok(
                    json!({"ok":false,"message":format!("spawnSync {} {reason}", bin.display())}),
                );
            }
            if let Some(exit) = proc.try_wait()? {
                break exit;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let read = |f: &mut fs::File| -> io::Result<String> {
            f.rewind()?;
            let mut bytes = Vec::new();
            f.take(limit).read_to_end(&mut bytes)?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        };
        if let Some(code) = status.code()
            && code != 0
        {
            return Ok(
                json!({"ok":false,"message":format!("exit {code}"),"stderr":read(&mut err)?.trim()}),
            );
        }
        let log = read(&mut out)? + &read(&mut err)?;
        Ok(json!({"ok":true,"versionLine":log.split('\n').find(|s| !s.is_empty()).unwrap_or("")}))
    };
    capture().unwrap_or_else(|e| json!({"ok":false,"message":e.to_string()}))
}

fn engine_status(id: &str) -> Result<Value, String> {
    install::request("getEngineStatus", &json!({"engineId":id}))
}
fn engine_probe(status: &Value) -> Result<Value, String> {
    let Some(binary) = status["resolvedBinary"].as_str() else {
        return Ok(json!({"ok":false,"message":"missing binary"}));
    };
    let mut p = install::request(
        "probeEngine",
        &json!({"engineId":status["id"],"binaryPath":binary}),
    )?;
    if let Some(msg) = p["message"].as_str() {
        if msg == "Operation timed out" {
            p["message"] = "probe timed out".into();
        } else if let Some((code, help)) = msg
            .strip_prefix("Unexpected engine help (")
            .and_then(|s| s.split_once("): "))
        {
            let detail = help.split_whitespace().collect::<Vec<_>>().join(" ");
            let detail = if detail.is_empty() {
                code.replace("exit status: ", "exit ")
            } else {
                detail
            };
            let msg = format!(
                "unexpected {} help output: {detail}",
                text(status, "command")
            );
            p["message"] = msg.chars().take(240).collect::<String>().into();
        }
    }
    Ok(p)
}

fn microphones(ffmpeg: Option<&Path>) -> Vec<String> {
    let Some(ffmpeg) = ffmpeg else {
        return vec!["default".into()];
    };
    if env::var_os("RAGE_FFMPEG").as_deref() == Some(ffmpeg.as_os_str()) {
        return audio::devices().unwrap_or_default();
    }
    // Give the scanner this resolution without mutating the process environment.
    env::current_exe()
        .ok()
        .and_then(|exe| {
            Command::new(exe)
                .arg("devices")
                .env("RAGE_FFMPEG", ffmpeg)
                .stdin(Stdio::null())
                .output()
                .ok()
        })
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice(&o.stdout).ok())
        .unwrap_or_default()
}

fn doctor(as_json: bool) -> Result<i32, String> {
    let engine = engine_status("whisper.cpp")?;
    let sidecar = engine_status("transcribe-cpp")?;
    let probe = engine_probe(&engine)?;
    let sidecar_probe = engine_probe(&sidecar)?;
    let paths = |op| catalog::request(op, &json!({}));
    let cache = paths("getCacheDir")?;
    let ffmpeg = recorder_path("ffmpeg", &["RAGE_FFMPEG", "OPENCODE_VOICE_FFMPEG"]);
    let arecord = recorder_path("arecord", &["RAGE_ARECORD"]);
    let sox = recorder_path("sox", &["RAGE_SOX"]);
    let platform = text(&engine, "platform");
    let dir = Path::new(cache.as_str().ok_or("Invalid cache path")?)
        .join("recorders/ffmpeg-static")
        .join(&platform);
    let bin = dir.join("ffmpeg");
    let manifest: Value = fs::read(dir.join("manifest.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let recsrc = match ffmpeg.as_deref() {
        None => "missing",
        Some(p) if p == bin => "managed",
        _ => "system-or-bundled",
    };
    let recorder = json!({"id":"ffmpeg","command":"ffmpeg","platform":platform,"supported":false,
        "managedDir":dir,"managedBinary":bin,"managedInstalled":executable(&bin),"manifest":manifest,"resolvedBinary":ffmpeg,"source":recsrc});
    let rec = json!({"ffmpeg":ffmpeg,"arecord":arecord,"sox":sox,"ffmpegPresent":ffmpeg.is_some(),"arecordPresent":arecord.is_some(),"soxPresent":sox.is_some(),
        "ffmpegProbe":probe_recorder(ffmpeg.as_deref(),"-version"),"arecordProbe":probe_recorder(arecord.as_deref(),"--help"),"soxProbe":probe_recorder(sox.as_deref(),"--help"),
        "managedInstall":null,"managedInstallError":""});
    let mics = microphones(ffmpeg.as_deref());
    let models = paths("getModelsDir")?;
    let recordings = paths("getAudioDir")?;
    if as_json {
        let payload = json!({"platform":platform,"cacheDir":cache,"modelsDir":models,"recordingsDir":recordings,"engine":engine,"probe":probe,"sidecar":sidecar,"sidecarProbe":sidecar_probe,"recorder":recorder,"recorders":rec,"microphones":mics});
        println!("{payload:#}");
    } else {
        let message = |p: &Value| {
            if p["ok"] == true {
                "ok".into()
            } else {
                text(p, "message")
            }
        };
        let available = |k: &str| {
            rec[k]
                .as_str()
                .map(|p| format!("yes ({p})"))
                .unwrap_or("no".into())
        };
        println!(
            "rage doctor\n\nPlatform: {platform}\nCache dir: {}\nModels dir: {}\nRecordings dir: {}",
            cache.as_str().unwrap_or(""),
            models.as_str().unwrap_or(""),
            recordings.as_str().unwrap_or("")
        );
        println!(
            "Engine source: {}\nManaged engine dir: {}\nwhisper-cli: {}\nProbe: {}",
            text(&engine, "source"),
            text(&engine, "managedDir"),
            text(&engine, "resolvedBinary"),
            message(&probe)
        );
        println!(
            "Sidecar source: {}\nopencode-voice-transcribe: {}\nSidecar probe: {}",
            text(&sidecar, "source"),
            text(&sidecar, "resolvedBinary"),
            message(&sidecar_probe)
        );
        println!(
            "Recorder source: {recsrc}\nManaged recorder dir: {}\nManaged recorder installed: {}\nManaged recorder version: {}\nManaged recorder probe: {}",
            dir.display(),
            yes(executable(&bin)),
            text(&manifest, "version"),
            message(&rec["ffmpegProbe"])
        );
        println!(
            "Recorders: ffmpeg={}, arecord={}, sox={}\nMicrophones: {}",
            available("ffmpeg"),
            available("arecord"),
            available("sox"),
            mics.join(", ")
        );
    }
    let ready = (probe["ok"] == true || sidecar_probe["ok"] == true)
        && (rec["ffmpegProbe"]["ok"] == true || rec["soxProbe"]["ok"] == true);
    Ok(i32::from(!ready))
}

fn engine(args: &[String]) -> Result<i32, String> {
    let id = args.get(1).map(String::as_str).unwrap_or("whisper.cpp");
    if !matches!(id, "whisper.cpp" | "transcribe-cpp") {
        return Err(format!("Unsupported engine: {id}"));
    }
    match args.first().map(String::as_str) {
        Some("status") => {
            let s = engine_status(id)?;
            if args.iter().any(|a| a == "--json") {
                println!("{s:#}");
            } else {
                println!(
                    "Engine: {id}\nPlatform: {}\nSource: {}\nResolved binary: {}\nManaged binary: {}\nManaged installed: {}\nManaged version: {}",
                    text(&s, "platform"),
                    text(&s, "source"),
                    text(&s, "resolvedBinary"),
                    text(&s, "managedBinary"),
                    yes(s["managedInstalled"] == true),
                    text(&s["manifest"], "version")
                );
            }
            return Ok(i32::from(s["resolvedBinary"].is_null()));
        }
        Some("remove") => {
            let dir = install::request("removeManagedEngine", &json!({"engineId":id}))?;
            println!(
                "Removed managed {id}: {}",
                dir.as_str().ok_or("Invalid engine directory")?
            );
        }
        Some("import") => {
            let status = engine_status(id)?;
            let source = args
                .get(2)
                .map(String::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    (status["source"] != "managed")
                        .then(|| status["resolvedBinary"].as_str())
                        .flatten()
                })
                .ok_or_else(|| format!("Pass an {} path to import", text(&status, "command")))?;
            let result = install::request(
                "importManagedEngine",
                &json!({"engineId":id,"sourcePath":source}),
            )?;
            println!("Imported {id}: {}", text(&result, "managedBinary"));
        }
        Some("install") => {
            let result = managed_install(id)?;
            println!("Installed {id}: {}", text(&result, "managedBinary"));
        }
        _ => {
            println!("{HELP}");
            return Ok(1);
        }
    }
    Ok(0)
}

fn managed_install(id: &str) -> Result<Value, String> {
    let io_err = |e: io::Error| e.to_string();
    let mut errors = tempfile::tempfile().map_err(io_err)?;
    let mut child = Command::new(env::current_exe().map_err(io_err)?)
        .args(["asset", "installManagedEngine"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(errors.try_clone().map_err(io_err)?)
        .spawn()
        .map_err(io_err)?;
    let frames = (|| -> Result<Option<Value>, String> {
        writeln!(
            child.stdin.take().ok_or("Missing installer stdin")?,
            "{}",
            json!({"engineId":id,"stream":true})
        )
        .map_err(io_err)?;
        let mut result = None;
        for line in BufReader::new(child.stdout.take().ok_or("Missing installer stdout")?).lines() {
            let frame: Value =
                serde_json::from_str(&line.map_err(io_err)?).map_err(|e| e.to_string())?;
            if let Some(p) = frame.get("progress") {
                let label = match p["state"].as_str() {
                    Some("downloading") => "download",
                    Some("done") => "done",
                    _ => continue,
                };
                if let Some(percent) = p["percent"].as_f64() {
                    println!("engine {label} {}%", percent.round());
                } else {
                    println!("engine {label}");
                }
            } else if let Some(r) = frame.get("retry") {
                eprintln!(
                    "engine retry {}/{}: {}",
                    r["nextAttempt"],
                    r["attempts"],
                    text(r, "error")
                );
            } else if let Some(v) = frame.get("result") {
                result = Some(v.clone());
            }
        }
        Ok(result)
    })();
    if frames.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(io_err)?;
    let result = frames?;
    if !status.success() {
        errors.rewind().map_err(io_err)?;
        let mut error = String::new();
        errors
            .take(16 * 1024)
            .read_to_string(&mut error)
            .map_err(io_err)?;
        return Err(if error.trim().is_empty() {
            format!("Installer failed ({status})")
        } else {
            error.trim().into()
        });
    }
    result.ok_or_else(|| "Installer did not return a result".into())
}

fn plugin(args: &[String], update: bool) -> Result<i32, String> {
    let meta: Value =
        serde_json::from_str(include_str!("../../package.json")).map_err(|e| e.to_string())?;
    let package = env::var("OPENCODE_VOICE_PACKAGE")
        .ok()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| meta["name"].as_str().unwrap_or("opencode-voice").into());
    let mut cmd = Command::new("opencode");
    cmd.args(["plugin", &package]);
    if update {
        cmd.arg("--force");
    }
    cmd.args(args.iter().filter(|a| {
        if update {
            *a == "--global"
        } else {
            *a != "--no-engine"
        }
    }));
    let status = cmd.status().map_err(|e| {
        let error = match e.kind() {
            io::ErrorKind::NotFound => "spawnSync opencode ENOENT".into(),
            io::ErrorKind::PermissionDenied => "spawnSync opencode EACCES".into(),
            _ => e.to_string(),
        };
        format!("Failed to run opencode: {error}")
    })?;
    let code = status.code().unwrap_or(1);
    if code == 0 && !update && !args.iter().any(|a| a == "--no-engine") {
        println!("Installing managed voice engine...");
        let result = managed_install("whisper.cpp")?;
        println!(
            "Managed voice engine ready: {}",
            text(&result, "managedBinary")
        );
    }
    Ok(code)
}

pub fn run(args: &[String]) -> Result<i32, String> {
    match args.split_first().map(|(cmd, rest)| (cmd.as_str(), rest)) {
        Some(("install", rest)) => plugin(rest, false),
        Some(("update", rest)) => plugin(rest, true),
        Some(("doctor", rest)) => doctor(rest.iter().any(|a| a == "--json")),
        Some(("engine", rest)) => engine(rest),
        _ => {
            println!("{HELP}");
            Ok(0)
        }
    }
}
