use serde_json::{Value, json};
use std::sync::LazyLock;
#[path = "dialog_extra.rs"]
mod dialog_extra;

static DATA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/menu-data.json")).expect("checked-in menu data")
});

fn transition(screen: &str, a: &Value) -> Result<Value, String> {
    let pick = a["picked"].as_str();
    let s = &a["settings"];
    let back = match screen {
        "recording" | "transcription" | "system" | "uiLanguage" => "root",
        "key" | "cutoff" => "recording",
        "language" => "transcription",
        _ => "",
    };
    let go = |page: &str| json!({"next":page});
    let set = |key: &str, value: Value, page: &str| json!({"set":[key,value],"next":page});
    let Some(p) = pick else { return Ok(go(back)) };
    let prompt = |key: &str, title: &str, placeholder: &str, value: Value| json!({"prompt":{"title":title,"placeholder":placeholder,"value":value},"field":key});
    if a["answered"] == true {
        let Some(v) = a["answer"].as_str() else {
            return Ok(go(screen));
        };
        let v = v.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'));
        return Ok(match screen {
            "language" => set(
                "language",
                json!(if v.is_empty() { "auto" } else { v }),
                back,
            ),
            "key" => set(
                "recordingHotkey",
                if v.is_empty() {
                    s["recordingHotkey"].clone()
                } else {
                    json!(v)
                },
                back,
            ),
            "cutoff" => {
                let hz = crate::preferences::request("parseCutoffHz", &json!({"value":v}))?;
                if hz.is_null() {
                    json!({"warning":"Cutoff must be 40-500 Hz.","next":screen})
                } else {
                    set("cleanupCutoffHz", hz, back)
                }
            }
            "system" => set("downloadDir", json!(v), screen),
            _ => return Err(format!("Unexpected prompt answer: {screen}")),
        });
    }
    Ok(match (screen, p) {
        ("root", "mic" | "recording" | "transcription" | "system" | "uiLanguage")
        | ("recording", "key" | "cutoff")
        | ("transcription", "language" | "download" | "downloadError" | "model")
        | ("system", "engine" | "diagnostics") => go(p),
        ("recording", "animation" | "cleanup") | ("transcription", "autoSubmit") => {
            let k = match p {
                "animation" => "voiceAnimation",
                "cleanup" => "voiceEnhance",
                _ => "autoSubmit",
            };
            set(k, json!(!s[k].as_bool().unwrap_or(false)), screen)
        }
        ("system", "downloadDir") => {
            let mut effect = prompt(
                "downloadDir",
                "Storage directory",
                a["defaultDir"].as_str().unwrap_or(""),
                s["downloadDir"].clone(),
            );
            effect["prompt"]["description"] =
                json!("Models, recordings and engines. Leave empty for the default.");
            effect
        }
        ("language", "__custom") => prompt(
            "language",
            "Custom language code",
            "ru, en, de, ...",
            if s["language"] == "auto" {
                json!("")
            } else {
                s["language"].clone()
            },
        ),
        ("key", "__custom") => prompt(
            "recordingHotkey",
            "Custom recording key",
            "alt+shift+r",
            s["recordingHotkey"].clone(),
        ),
        ("cutoff", "__custom") => prompt(
            "cleanupCutoffHz",
            "Custom cutoff frequency",
            "120",
            json!(s["cleanupCutoffHz"].to_string()),
        ),
        ("language", _) => set("language", json!(p), back),
        ("key", _) => set("recordingHotkey", json!(p), back),
        ("cutoff", _) => set(
            "cleanupCutoffHz",
            json!(p.parse::<u32>().map_err(|_| "Invalid cutoff selection")?),
            back,
        ),
        ("uiLanguage", "en" | "ru" | "auto") => set("uiLanguage", json!(p), back),
        ("uiLanguage", _) => go(back),
        ("recording", _) => go(screen),
        _ => go(""),
    })
}

pub fn request(screen: &str, args: &Value) -> Result<Value, String> {
    if let Some(op) = screen.strip_prefix("extra/") {
        return dialog_extra::request(op, args);
    }
    if let Some(screen) = screen.strip_prefix("select/") {
        return transition(screen, args);
    }
    let s = &args["settings"];
    let ru = args["language"] == "ru";
    let tr = |k: &str| -> String {
        (if ru { DATA["ru"][k].as_str() } else { None })
            .unwrap_or(k)
            .into()
    };
    let text = |k: &str| s[k].as_str().unwrap_or("");
    let on = |k: &str| s[k].as_bool().unwrap_or(false);
    let toggle = |k: &str| tr(if on(k) { "enabled" } else { "disabled" });
    let row = |name: &str, value: &str| json!({"title":tr(name),"value":value});
    let desc = |name: &str, value: &str, d: String| json!({"title":tr(name),"value":value,"description":d});
    let mut current = None;
    let language = text("language");
    let key = text("recordingHotkey");
    let cutoff = s["cleanupCutoffHz"].to_string();
    let hz = tr("Hz");
    let (title, rows) = match screen {
        "root" => (
            "Voice settings",
            vec![
                desc(
                    "Microphone",
                    "mic",
                    args["micLabel"].as_str().unwrap_or("").into(),
                ),
                desc(
                    "Recording",
                    "recording",
                    if key.is_empty() {
                        tr("No shortcut")
                    } else {
                        format!("{key} · {}", tr("toggle"))
                    },
                ),
                desc(
                    "Transcription",
                    "transcription",
                    format!(
                        "{} · {}",
                        args["name"].as_str().unwrap_or(""),
                        if language == "auto" {
                            tr("auto language")
                        } else {
                            language.into()
                        }
                    ),
                ),
                desc("System", "system", tr("Storage and engine")),
                row("Interface language", "uiLanguage"),
            ],
        ),
        "recording" => {
            let mut filter = desc(
                "Rumble filter",
                "cutoff",
                if on("voiceEnhance") {
                    format!("{cutoff} {hz}")
                } else {
                    tr("off (cleanup disabled)")
                },
            );
            filter["disabled"] = json!(!on("voiceEnhance"));
            (
                "Recording",
                vec![
                    desc(
                        "Record key",
                        "key",
                        if key.is_empty() {
                            tr("No shortcut")
                        } else {
                            key.into()
                        },
                    ),
                    desc("Activity animations", "animation", toggle("voiceAnimation")),
                    desc("Voice cleanup", "cleanup", toggle("voiceEnhance")),
                    filter,
                ],
            )
        }
        "key" => {
            current = Some(
                if ["", "ctrl+space", "ctrl+r", "alt+r"].contains(&key) {
                    key
                } else {
                    "__custom"
                }
                .to_owned(),
            );
            (
                "Record key",
                vec![
                    row("No shortcut", ""),
                    row("Ctrl + Space", "ctrl+space"),
                    desc("Ctrl + R", "ctrl+r", tr("Also renames sessions")),
                    row("Alt + R", "alt+r"),
                    row("Custom hotkey", "__custom"),
                ],
            )
        }
        "cutoff" => {
            current = Some(if ["80", "120", "180"].contains(&cutoff.as_str()) {
                cutoff.clone()
            } else {
                "__custom".into()
            });
            let mut rows: Vec<_> = [("80", "Gentle"), ("120", "Default"), ("180", "Strong")]
                .iter()
                .map(|(n, label)| desc(&format!("{n} {hz}"), n, tr(label)))
                .collect();
            rows.push(desc("Custom cutoff", "__custom", format!("40–500 {hz}")));
            ("Rumble filter cutoff", rows)
        }
        "language" => {
            let mut rows = vec![row("Auto detect", "auto")];
            let mut known = language == "auto";
            for l in DATA["languages"].as_array().into_iter().flatten() {
                known |= l["code"] == language;
                rows.push(
                    json!({"title":l[if ru{"ru"}else{"en"}],"value":l["code"],"footer":l["code"]}),
                );
            }
            rows.push(if known {
                row("Custom code", "__custom")
            } else {
                desc("Custom code", "__custom", language.into())
            });
            current = Some(if known { language } else { "__custom" }.into());
            ("Voice language", rows)
        }
        "uiLanguage" => {
            current = Some(text("uiLanguage").into());
            (
                "Interface language",
                vec![
                    row("Follow system language", "auto"),
                    json!({"title":"English","value":"en"}),
                    json!({"title":"Русский","value":"ru"}),
                ],
            )
        }
        "system" => (
            "System",
            vec![
                desc(
                    "Storage directory",
                    "downloadDir",
                    args["dir"].as_str().unwrap_or("").into(),
                ),
                desc(
                    "Native engine",
                    "engine",
                    format!(
                        "{} · {}",
                        tr(args["source"].as_str().unwrap_or("")),
                        args["engine"].as_str().unwrap_or("")
                    ),
                ),
                row("Diagnostics", "diagnostics"),
            ],
        ),
        "transcription" => {
            let ready = args["downloaded"] == true;
            let mut model = desc("Model", "model", args["name"].as_str().unwrap_or("").into());
            if ready {
                model["footer"] = tr("ready").into();
            }
            let mut rows = vec![model];
            if !ready {
                let phase = args["status"]["phase"].as_str();
                let busy = matches!(phase, Some("downloading" | "verifying"));
                let mut download = desc(
                    match phase {
                        Some("downloading") => "Downloading…",
                        Some("verifying") => "Verifying…",
                        _ => "Download model",
                    },
                    "download",
                    if busy {
                        &args["status"]["detail"]
                    } else {
                        &args["size"]
                    }
                    .as_str()
                    .unwrap_or("")
                    .into(),
                );
                download["disabled"] = json!(busy);
                rows.push(download);
                if phase == Some("failed") {
                    rows.push(row("Show download error", "downloadError"));
                }
            }
            rows.push(desc(
                "Language",
                "language",
                if language == "auto" {
                    tr("auto detect")
                } else {
                    language.into()
                },
            ));
            rows.push(desc("Auto-submit", "autoSubmit", toggle("autoSubmit")));
            ("Transcription", rows)
        }
        _ => return Err(format!("Unknown menu: {screen}")),
    };
    let mut view = json!({"title":tr(title),"placeholder":tr("Search…"),"options":rows});
    if let Some(value) = current {
        view["current"] = value.into();
    }
    Ok(view)
}
