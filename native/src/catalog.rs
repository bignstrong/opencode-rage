//! Model metadata embedded from the baseline's integrity-checked catalog.
//! `getModel` is the historical fallback lookup. `selectModel` requires an exact ID.
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs::{self, Metadata};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

static DATA: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("catalog.json")).expect("embedded catalog"));

pub(crate) fn defaults() -> &'static Value {
    &DATA["defaults"]
}
fn models() -> &'static [Value] {
    DATA["models"].as_array().expect("embedded models")
}
fn exact(id: &Value) -> Option<&'static Value> {
    models().iter().find(|m| &m["id"] == id)
}
pub(crate) fn get_model(id: &Value) -> &'static Value {
    exact(id).unwrap_or_else(|| exact(&DATA["defaultId"]).expect("embedded default model"))
}

fn clean_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in p.components() {
        match component {
            Component::CurDir => (),
            Component::ParentDir if out.file_name().is_some() => {
                out.pop();
            }
            Component::ParentDir if out.has_root() => (),
            _ => out.push(component),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}
fn home() -> Result<PathBuf, String> {
    std::env::home_dir().ok_or_else(|| "Cannot resolve home directory".into())
}
fn expand(s: &str) -> Result<PathBuf, String> {
    match s {
        "~" => home(),
        _ if s.starts_with("~/") => Ok(clean_path(&home()?.join(s[2..].trim_start_matches('/')))),
        _ => Ok(s.into()),
    }
}
fn cache(args: &Value) -> Result<PathBuf, String> {
    let env = std::env::var("OPENCODE_VOICE_DIR").ok();
    let configured = [
        &args["settings"]["downloadDir"],
        &args["options"]["downloadDir"],
    ]
    .into_iter()
    .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
    .or_else(|| env.as_deref().filter(|s| !s.is_empty()));
    if let Some(s) = configured {
        return Ok(clean_path(
            &std::path::absolute(expand(s)?).map_err(|e| e.to_string())?,
        ));
    }
    let root = match std::env::var_os("XDG_CACHE_HOME").filter(|s| !s.is_empty()) {
        Some(root) => root.into(),
        None => home()?.join(".cache"),
    };
    Ok(clean_path(&root.join("opencode-voice")))
}

fn missing(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}
fn model_path(model: &Value, args: &Value) -> Result<Option<PathBuf>, String> {
    match model["filename"].as_str().filter(|s| !s.is_empty()) {
        Some(s) => Ok(Some(clean_path(
            &cache(args)?.join("models").join(s.trim_start_matches('/')),
        ))),
        None => Ok(None),
    }
}
fn marker(file: &Path) -> PathBuf {
    let mut p = file.as_os_str().to_owned();
    p.push(".sha256");
    p.into()
}
fn stamp(
    digest: &str,
    dev: impl std::fmt::Display,
    ino: impl std::fmt::Display,
    size: impl std::fmt::Display,
    mtime: impl std::fmt::Display,
    ctime: impl std::fmt::Display,
) -> String {
    format!(
        "{} {dev}:{ino}:{size}:{mtime}:{ctime}",
        digest.to_ascii_lowercase()
    )
}
#[cfg(unix)]
fn file_stamp(digest: &str, stat: &Metadata) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    let ns = |s: i64, n: i64| i128::from(s) * 1_000_000_000 + i128::from(n);
    Ok(stamp(
        digest,
        stat.dev(),
        stat.ino(),
        stat.len(),
        ns(stat.mtime(), stat.mtime_nsec()),
        ns(stat.ctime(), stat.ctime_nsec()),
    ))
}
#[cfg(not(unix))]
fn file_stamp(_: &str, _: &Metadata) -> Result<String, String> {
    Err("File verification stamps are not implemented on this platform".into())
}
fn verified(file: &Path, digest: &str, stat: &Metadata, listing: bool) -> Result<bool, String> {
    let bytes = match fs::read(marker(file)) {
        Ok(bytes) => bytes,
        Err(e) if missing(&e) => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    let text = String::from_utf8_lossy(&bytes).trim().to_ascii_lowercase();
    Ok((listing && text.eq_ignore_ascii_case(digest)) || text == file_stamp(digest, stat)?)
}

fn inventory(args: &Value) -> Result<Value, String> {
    let dir = cache(args)?.join("models");
    let names = match fs::read_dir(&dir) {
        Ok(entries) => Some(
            entries
                .map(|e| e.map(|e| e.file_name().to_string_lossy().to_lowercase()))
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|e| e.to_string())?,
        ),
        Err(e) if missing(&e) => Some(HashSet::new()),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => None,
        Err(e) => return Err(e.to_string()),
    };
    let listed = |name: &str| {
        names.as_ref().map_or_else(
            || dir.join(name).exists(),
            |n| n.contains(&name.to_lowercase()),
        )
    };
    let status = |m: &Value| -> Result<&str, String> {
        if m["implemented"] != true {
            return Ok("planned");
        }
        let Some(name) = m["filename"].as_str().filter(|s| listed(s)) else {
            return Ok("not downloaded");
        };
        let p = dir.join(name);
        let stat = match p.metadata() {
            Ok(stat) if stat.is_file() && stat.len() > 0 => stat,
            Ok(_) => return Ok("not downloaded"),
            Err(e) if missing(&e) || e.kind() == ErrorKind::PermissionDenied => {
                return Ok("not downloaded");
            }
            Err(e) => return Err(e.to_string()),
        };
        let Some(digest) = m["sha256"].as_str().filter(|s| !s.is_empty()) else {
            return Ok("downloaded");
        };
        Ok(
            if listed(&format!("{name}.sha256")) && verified(&p, digest, &stat, true)? {
                "downloaded"
            } else {
                "needs verification"
            },
        )
    };
    models()
        .iter()
        .map(|m| Ok(json!({"model":m,"status":status(m)?})))
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn format_size(m: &Value) -> String {
    let size = m["sizeMB"].as_f64().unwrap_or_default();
    let gb = 1000_f64;
    if size >= gb {
        let n = size / gb;
        // JS toFixed rounds an exact .25 up to .3; Rust formats ties to even.
        format!("{:.1} GB", if n.fract() == 0.25 { n.next_up() } else { n })
    } else if size == 0.0 {
        "unknown size".into()
    } else {
        format!("{size} MB")
    }
}

fn picker_rows(args: &Value) -> Result<Value, String> {
    let Value::Array(mut entries) = inventory(args)? else {
        return Err("Expected inventory".into());
    };
    let groups = [
        "downloaded",
        "needs verification",
        "not downloaded",
        "planned",
    ];
    entries.sort_by_key(|e| groups.iter().position(|s| e["status"] == *s));
    let words = &args["words"];
    let rows = entries.into_iter().map(|e| {
        let model = &e["model"];
        let raw = model["languages"].as_str().unwrap_or_default();
        let languages = if raw.encode_utf16().count() > 20 {
            format!("{} {}", raw.split(',').count(), words["langs"].as_str().unwrap_or("langs"))
        } else {
            words[raw].as_str().unwrap_or(raw).to_owned()
        };
        let mut size = format_size(model);
        if args["uiLanguage"] == "ru" {
            size = if size == "unknown size" { "размер неизвестен".into() }
            else { size.replace(" MB", " МБ").replace(" GB", " ГБ").replace('.', ",") };
        }
        let name = model["name"].as_str().unwrap_or_default();
        json!({
            "title": name.strip_suffix("-gguf").unwrap_or(name), "value":model["id"],
            "category": words[e["status"].as_str().unwrap_or_default()],
            "disabled": model["implemented"] != true,
            "footer": format!("{size} · {languages} · {}", model["engine"].as_str().unwrap_or_default()),
        })
    }).collect();
    Ok(Value::Array(rows))
}

pub fn request(op: &str, args: &Value) -> Result<Value, String> {
    let m = &args["model"];
    let value = match op {
        "models" => DATA["models"].clone(),
        "defaults" => defaults().clone(),
        "getModel" => get_model(&args["id"]).clone(),
        "selectModel" => exact(&args["id"])
            .filter(|m| m["implemented"] == true)
            .ok_or_else(|| format!("Unknown or unavailable model: {}", args["id"]))?
            .clone(),
        "getModelInventory" => return inventory(args),
        "pickerRows" => return picker_rows(args),
        "formatSize" => json!(format_size(m)),
        "expandHome" => match args["value"].as_str() {
            Some(s) => json!(expand(s)?),
            None => args["value"].clone(),
        },
        "getCacheDir" => json!(cache(args)?),
        "getModelsDir" => json!(cache(args)?.join("models")),
        "getAudioDir" => json!(cache(args)?.join("recordings")),
        "getEnginesDir" => json!(cache(args)?.join("engines")),
        "getModelPath" | "getModelVerificationPath" => match model_path(m, args)? {
            None => json!(""),
            Some(p) if op == "getModelVerificationPath" => json!(marker(&p)),
            Some(p) => json!(p),
        },
        "isModelFilePresent" | "isModelDownloaded" => {
            let Some(p) = model_path(m, args)? else {
                return Ok(json!(false));
            };
            let stat = match p.metadata() {
                Ok(stat) => stat,
                Err(e) if missing(&e) => return Ok(json!(false)),
                Err(e) if op == "isModelFilePresent" && e.kind() == ErrorKind::PermissionDenied => {
                    return Ok(json!(false));
                }
                Err(e) => return Err(e.to_string()),
            };
            let digest = m["sha256"].as_str().unwrap_or_default();
            json!(
                stat.len() > 0
                    && (op == "isModelFilePresent"
                        || (stat.is_file()
                            && (digest.is_empty() || verified(&p, digest, &stat, false)?)))
            )
        }
        "modelVerificationStamp" => {
            let s = &args["stat"];
            let field = |name: &str| {
                s[name]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| s[name].to_string())
            };
            json!(stamp(
                args["digest"].as_str().ok_or("Expected digest")?,
                field("dev"),
                field("ino"),
                field("size"),
                field("mtimeNs"),
                field("ctimeNs")
            ))
        }
        _ => return Err(format!("Unknown catalog operation: {op}")),
    };
    Ok(value)
}
