use serde_json::{Value, json};

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

fn display_size(size: &str, ru: bool) -> String {
    if !ru {
        size.into()
    } else if size == "unknown size" {
        "размер неизвестен".into()
    } else {
        size.replace(" MB", " МБ")
            .replace(" GB", " ГБ")
            .replace('.', ",")
    }
}

// Built-in inventory is already formatted by catalog::picker_rows. Host inventory
// comes from an extended catalog or virtual filesystem; retain its order within groups.
fn model_rows(a: &Value, ru: bool, t: &impl Fn(&str) -> String) -> Result<Vec<Value>, String> {
    if let Some(rows) = a["rows"].as_array() {
        return Ok(rows.clone());
    }
    let inventory = a["inventory"].as_array().ok_or("Missing model inventory")?;
    let mut rows = Vec::with_capacity(inventory.len());
    for (status, category) in [
        ("downloaded", "Downloaded models"),
        ("needs verification", "Pending verification"),
        ("not downloaded", "Available to download"),
        ("planned", "Planned sidecar models"),
    ] {
        for model in inventory.iter().filter(|m| m["status"] == status) {
            let raw = text(model, "languages");
            let langs = if raw.encode_utf16().count() > 20 {
                format!("{} {}", raw.split(',').count(), t("langs"))
            } else if matches!(raw, "multilingual" | "English") {
                t(raw)
            } else {
                raw.to_owned()
            };
            let name = text(model, "name");
            rows.push(json!({"title":name.strip_suffix("-gguf").unwrap_or(name),"value":model["id"],"category":t(category),
                "disabled":model["implemented"]!=true,"footer":format!("{} · {langs} · {}",display_size(text(model,"size"),ru),text(model,"engine"))}));
        }
    }
    Ok(rows)
}

fn mic_value(s: &str, platform: &str) -> String {
    match (platform, s) {
        (_, "" | "default") | ("darwin", ":default") | ("win32", "audio=default") => String::new(),
        ("darwin", s) if !s.starts_with(':') => format!(":{s}"),
        _ => s.into(),
    }
}

fn index(s: &str) -> Option<&str> {
    s.strip_prefix(':')
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn decode(s: &str) -> Option<String> {
    let mut bytes = s.bytes();
    let mut out = Vec::new();
    while let Some(b) = bytes.next() {
        out.push(if b == b'%' {
            let hi = char::from(bytes.next()?).to_digit(16)?;
            let lo = char::from(bytes.next()?).to_digit(16)?;
            (hi * 16 + lo) as u8
        } else {
            b
        });
    }
    String::from_utf8(out).ok()
}

fn mic_label(value: &str, platform: &str, t: &impl Fn(&str) -> String) -> String {
    let s = mic_value(value, platform);
    if s.is_empty() {
        return t("System default");
    }
    if platform != "darwin" {
        return s;
    }
    if let Some(n) = index(&s) {
        return format!("{} {n}", t("Device index"));
    }
    if let Some(rest) = s.strip_prefix(":uid:") {
        if let Some((uid, name)) = rest.split_once(':')
            && !uid.is_empty()
            && !name.is_empty()
            && !name.contains(':')
            && decode(uid).is_some()
            && let Some(name) = decode(name)
        {
            return name;
        }
        return s;
    }
    s.strip_prefix("::")
        .or_else(|| s.strip_prefix(':'))
        .unwrap_or(&s)
        .into()
}

fn mic_view(a: &Value, t: &impl Fn(&str) -> String) -> Value {
    let platform = text(a, "platform");
    let saved = mic_value(text(&a["settings"], "mic"), platform);
    let devices = a["devices"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let identity = |s: &str| {
        s.strip_prefix(":uid:")
            .and_then(|v| v.split_once(':'))
            .filter(|(uid, _)| !uid.is_empty())
            .map(|(uid, _)| uid.len() + 6)
            .unwrap_or(s.len())
    };
    let equal = |l: &str, r: &str| {
        if platform == "darwin" {
            l[..identity(l)] == r[..identity(r)]
        } else {
            l == r
        }
    };
    let current = if platform == "win32"
        && let Some(name) = saved.strip_prefix("audio=")
        && devices.iter().any(|d| d["value"] == name)
    {
        name
    } else {
        devices
            .iter()
            .map(|d| text(d, "value"))
            .find(|v| equal(v, &saved))
            .unwrap_or(&saved)
    };
    let mut rows = vec![json!({"title":t("System default"),"value":""})];
    rows.extend_from_slice(devices);
    if !current.is_empty() && !devices.iter().any(|d| equal(text(d, "value"), current)) {
        rows.push(json!({"title":mic_label(current,platform,t),"value":current,"description":t(
            if platform=="darwin" && index(current).is_some() {"Legacy selection"}else{"Saved, not listed"})}));
    }
    rows.push(json!({"title":t("Custom device"),"value":"__custom"}));
    if platform == "darwin" {
        rows.push(json!({"title":t("Find iPhone"),"value":"__iphoneHelp"}));
    }
    json!({"title":t("Voice microphone"),"placeholder":t("Search…"),"current":current,"options":rows})
}

pub(super) fn request(op: &str, a: &Value) -> Result<Value, String> {
    let s = &a["settings"];
    let st = &a["status"];
    let ru = a["language"] == "ru";
    let t = |k: &str| {
        if ru {
            super::DATA["ru"][k].as_str().unwrap_or(k).to_owned()
        } else {
            k.into()
        }
    };
    let pick = a["picked"].as_str();
    let first = a["firstRun"] == true;
    let platform = text(a, "platform");
    Ok(match op {
        "startup" => {
            if s["onboardingDone"] != true {
                json!(true)
            } else if s["setupSkipped"] == true {
                json!(false)
            } else {
                json!("checkDownload")
            }
        }
        "model" => {
            let mut rows = model_rows(a, ru, &t)?;
            if first {
                rows.push(json!({"title":t("Skip setup for now"),"value":"__skip","category":t("Setup"),"description":"/voice-settings"}));
            }
            json!({"title":t(if first {"Set up voice input: choose a local model"}else{"Voice model"}),
                "placeholder":t("Search voice models..."),"current":s["model"],"options":rows})
        }
        "modelPick" => match pick {
            None => json!({"next":if first {""}else{"transcription"}}),
            Some("__skip") => {
                json!({"writes":[["onboardingDone",true],["setupSkipped",true]],"toast":t("Voice setup skipped. Use /voice-settings when ready.")})
            }
            Some(_) if a["model"]["implemented"] == true => {
                json!({"writes":[["model",a["model"]["id"]],["onboardingDone",true],["setupSkipped",false]],"next":"prepare"})
            }
            _ => json!({"next":"model"}),
        },
        "prepareError" => {
            if a["reported"] == true {
                Value::Null
            } else {
                json!(t("Voice setup failed"))
            }
        }
        "size" => json!(display_size(text(a, "size"), ru)),
        "micLabel" => json!(mic_label(text(s, "mic"), platform, &t)),
        "mic" => mic_view(a, &t),
        "micPick" => {
            let back = if a["standalone"] == true { "" } else { "root" };
            match pick {
                None => json!({"next":back}),
                Some("__iphoneHelp") => {
                    json!({"alert":{"title":t("iPhone not listed?"),"message":t("Check for the iPhone in Mac System Settings > Sound > Input. Enable Continuity Camera on the iPhone and keep it near the Mac. Close this message to refresh the list, or choose System default.")},"next":"mic"})
                }
                Some("__custom") if a["answered"] != true => {
                    json!({"prompt":{"title":t("Custom microphone device"),"value":s["mic"],
                    "placeholder":match platform {"darwin"=>":0","win32"=>"Microphone (USB Audio)",_=>"hw:0,0"}}})
                }
                Some("__custom") if a["answer"].is_null() => json!({"next":"mic"}),
                Some(p) => {
                    let value = if p == "__custom" {
                        mic_value(
                            text(a, "answer").trim_matches(|c: char| {
                                c == '\u{feff}' || c.is_whitespace() && c != '\u{85}'
                            }),
                            platform,
                        )
                    } else {
                        p.into()
                    };
                    if platform == "darwin" && matches!(value.as_str(), ":" | "::") {
                        json!({"next":"mic","warning":if ru {"Укажите имя или номер микрофона."}else{"Enter a microphone name or index."}})
                    } else {
                        json!({"writes":[["mic",value]],"next":back})
                    }
                }
            }
        }
        "diagnostics" => {
            let recorders = ["ffmpeg", "arecord", "sox"]
                .map(|k| {
                    format!(
                        "{k}={}",
                        t(if a["recorders"][k] == true {
                            "yes"
                        } else {
                            "no"
                        })
                    )
                })
                .join(", ");
            let mut lines = vec![
                format!("{}: {}", t("Platform"), text(a, "hostPlatform")),
                format!("{}: {recorders}", t("Recorder")),
                format!(
                    "{}: {}",
                    t("Microphone"),
                    mic_label(text(s, "mic"), platform, &t)
                ),
                format!(
                    "{}: {} ({})",
                    t("Engine"),
                    text(st, "id"),
                    t(text(st, "source"))
                ),
            ];
            if let Some(bin) = st["resolvedBinary"].as_str().filter(|s| !s.is_empty()) {
                lines.push(bin.into());
            }
            lines.extend([
                format!(
                    "{}: {} ({})",
                    t("Active model"),
                    text(a, "name"),
                    t(if a["downloaded"] == true {
                        "downloaded"
                    } else {
                        "not downloaded"
                    })
                ),
                format!("{}: {}", t("Model path"), text(a, "modelPath")),
                format!("{}: {}", t("Cache dir"), text(a, "cache")),
            ]);
            json!({"title":t("Voice diagnostics"),"message":lines.join("\n")})
        }
        "engine" => {
            let import = !text(st, "resolvedBinary").is_empty() && st["source"] != "managed";
            let managed = st["managedInstalled"] == true;
            let mut row =
                json!({"title":t("Import detected engine"),"value":"import","disabled":!import});
            if import {
                row["description"] = st["command"].clone();
            }
            json!({"title":format!("{} · {}",text(a,"engineId"),t(text(st,"source"))),"placeholder":t("Search…"),
                "options":[row,{"title":t(if managed {"Check or repair engine"}else{"Install managed engine"}),"value":"install","description":"GitHub Releases"},
                {"title":t("Remove managed engine"),"value":"remove","disabled":!managed}]})
        }
        "enginePick" => match pick {
            None => json!({"next":"system"}),
            Some("import" | "install" | "remove") => {
                let action = text(a, "picked");
                if a["failed"] == true {
                    json!({"error":t(match action {"import"=>"Engine import failed","install"=>"Engine install failed",_=>"Engine remove failed"}),"next":"engine"})
                } else if a["done"] == true {
                    match action {
                        "import" => {
                            json!({"toast":format!("{}: {}",t("Managed engine imported"),text(a,"managedBinary")),"variant":"success","next":"engine"})
                        }
                        "install" => {
                            json!({"toast":t("Managed engine ready"),"variant":"success","next":"engine"})
                        }
                        _ => json!({"toast":t("Managed engine removed"),"next":"engine"}),
                    }
                } else if action == "remove" && a["answered"] != true {
                    json!({"confirm":{"title":t("Remove managed engine?"),"message":st["managedBinary"],"label":{"confirm":t("Remove"),"cancel":t("Cancel")}}})
                } else if action == "remove" && a["answer"] != true {
                    json!({"next":"engine"})
                } else if action == "install" {
                    json!({"action":action,"toast":t("Installing engine…")})
                } else {
                    json!({"action":action})
                }
            }
            _ => json!({}),
        },
        _ => return Err(format!("Unknown dialog operation: {op}")),
    })
}
