//! Shared V1/V2 settings operations. An absent migration or invalid custom
//! cutoff returns JSON null (the wire equivalent of JavaScript `undefined`).
use crate::catalog;
use serde_json::{Map, Value, json};

const OPTION_KEYS: &[&str] = &[
    "recordingHotkey",
    "model",
    "language",
    "uiLanguage",
    "mic",
    "autoSubmit",
    "downloadDir",
    "voiceEnhance",
    "voiceAnimation",
    "orb",
    "cleanupCutoffHz",
];

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Object(_) | Value::Array(_) => true,
    }
}
fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Number(value) => {
            let n = value.as_f64().unwrap_or_default();
            if n == 0.0 {
                "0".into()
            } else if !(1e-6..1e21).contains(&n.abs()) {
                let repr = format!("{n:e}");
                if n.abs() >= 1e21 {
                    repr.replace('e', "e+")
                } else {
                    repr
                }
            } else {
                n.to_string()
            }
        }
        v => v.to_string(),
    }
}
fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}
fn text(v: &Value, fallback: &str) -> String {
    if truthy(v) {
        trim(&string(v)).to_owned()
    } else {
        fallback.to_owned()
    }
}
fn nullish_text(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        trim(&string(v)).to_owned()
    }
}
fn number(s: &str) -> Option<f64> {
    let s = trim(s);
    if s.is_empty() {
        return Some(0.);
    }
    if let Some((radix, digits)) = [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ]
    .iter()
    .find_map(|(prefix, radix)| s.strip_prefix(prefix).map(|digits| (*radix, digits)))
    {
        if digits.is_empty() {
            return None;
        }
        return digits.chars().try_fold(0.0, |n, c| {
            Some(n * f64::from(radix) + f64::from(c.to_digit(radix)?))
        });
    }
    s.parse::<f64>().ok().filter(|n| n.is_finite())
}
fn cutoff(v: &Value) -> u32 {
    let n = v.as_f64().or_else(|| v.as_str().and_then(number));
    match n {
        Some(n) if n > 0. && n <= 1000_f64 => n.round().clamp(40., 500.) as u32,
        _ => 120,
    }
}
fn object(v: &Value) -> Map<String, Value> {
    match v {
        Value::Object(obj) => obj.clone(),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        _ => Map::new(),
    }
}
fn normalize(raw: &Value) -> Value {
    let mut s = object(catalog::defaults());
    s.extend(object(raw));
    if catalog::get_model(&s["model"])["implemented"] != true {
        s.insert("model".into(), catalog::defaults()["model"].clone());
    }
    for key in ["recordingHotkey", "mic", "downloadDir", "language"] {
        let value = text(&s[key], "");
        s.insert(
            key.into(),
            json!(if key == "language" && value.is_empty() {
                "auto"
            } else {
                &value
            }),
        );
    }
    if !matches!(s["uiLanguage"].as_str(), Some("en" | "ru")) {
        s.insert("uiLanguage".into(), json!("auto"));
    }
    let auto_submit = s["autoSubmit"] == true || s["autoSubmit"].as_f64() == Some(1.);
    s.insert("autoSubmit".into(), json!(auto_submit));
    for key in ["onboardingDone", "setupSkipped"] {
        s.insert(key.into(), json!(truthy(&s[key])));
    }
    for key in ["voiceAnimation", "voiceEnhance"] {
        s.insert(key.into(), json!(s.get(key) != Some(&Value::Bool(false))));
    }
    let hz = cutoff(s.get("cleanupCutoffHz").unwrap_or(&Value::Null));
    s.insert("cleanupCutoffHz".into(), json!(hz));
    Value::Object(s)
}
fn merge_hotkey(current: &Value, legacy: &Value) -> Value {
    let key = if truthy(&current["recordingHotkey"]) {
        text(&current["recordingHotkey"], "")
    } else {
        ["hotkey", "toggleHotkey"]
            .iter()
            .map(|key| nullish_text(&legacy[key]))
            .find(|v| !v.is_empty())
            .unwrap_or_default()
    };
    let mut result = object(current);
    result.insert(
        "recordingHotkey".into(),
        json!(if key.is_empty() { "ctrl+space" } else { &key }),
    );
    Value::Object(result)
}
fn ui_language(args: &Value) -> Value {
    if matches!(args["preference"].as_str(), Some("ru" | "en")) {
        return args["preference"].clone();
    }
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|key| {
            if let Some(env) = args.get("env") {
                env.get(key).filter(|v| truthy(v)).map(string)
            } else {
                std::env::var(key).ok().filter(|v| !v.is_empty())
            }
        })
        .unwrap_or_else(|| args["fallbackLocale"].as_str().unwrap_or("en").to_owned());
    let ru = locale
        .as_bytes()
        .get(..2)
        .is_some_and(|p| p.eq_ignore_ascii_case(b"ru"))
        && matches!(
            locale.as_bytes().get(2),
            None | Some(b'-' | b'_' | b'.' | b'@')
        );
    json!(if ru { "ru" } else { "en" })
}

pub fn request(op: &str, args: &Value) -> Result<Value, String> {
    let s = &args["settings"];
    Ok(match op {
        "normalizeSettings" => normalize(&args["raw"]),
        "optionsOverlay" => Value::Object(
            OPTION_KEYS
                .iter()
                .filter_map(|&k| args["options"].get(k).map(|v| (k.to_owned(), v.clone())))
                .collect(),
        ),
        "mergeLegacyHotkey" => merge_hotkey(&args["current"], &args["legacy"]),
        "migrateHotkeyV2" if truthy(&s["hotkeyMigratedV2"]) => Value::Null,
        "migrateHotkeyV2" if s["recordingHotkey"] == "ctrl+r" => {
            json!({"recordingHotkey":"ctrl+space","hotkeyMigratedV2":true})
        }
        "migrateHotkeyV2" => json!({"hotkeyMigratedV2":true}),
        "migrateRecordingShortcut" if truthy(&s["hotkeyMigratedV3"]) => Value::Null,
        "migrateRecordingShortcut" => {
            let key = &s["recordingHotkey"];
            let old = key == "ctrl+space" || (key == "ctrl+r" && !truthy(&s["hotkeyMigratedV2"]));
            if old && key.as_str() != Some(&nullish_text(&args["configuredHotkey"])) {
                json!({"recordingHotkey":catalog::defaults()["recordingHotkey"],"hotkeyMigratedV3":true})
            } else {
                json!({"hotkeyMigratedV3":true})
            }
        }
        "normalizeCutoffHz" => json!(cutoff(&args["value"])),
        "parseCutoffHz" => json!(
            number(&nullish_text(&args["value"]))
                .filter(|v| (40.0..=500.0).contains(v))
                .map(|v| v.round() as u32)
        ),
        "buildFilterChain" if !truthy(&args["enabled"]) => Value::Null,
        "buildFilterChain" => json!(format!(
            "highpass=f={},adeclick,dynaudnorm=f=150:g=7,alimiter=limit=0.95",
            cutoff(&args["cutoffHz"])
        )),
        "resolveUiLanguage" => ui_language(args),
        _ => return Err(format!("Unknown preferences operation: {op}")),
    })
}
