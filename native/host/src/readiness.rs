//! V2 readiness policy. Promises, callback identity, timers and SDK calls stay in the host.
use napi_derive::napi;
use serde_json::{Value, json};

const RETRIES: u32 = 5;
const UPDATE_MS: f64 = 1500.0;

fn status(phase: &str, en: (&str, &str), ru: (&str, &str)) -> Value {
    json!({"phase":phase,"hint":en.0,"detail":en.1,"translations":{
        "en":{"hint":en.0,"detail":en.1}, "ru":{"hint":ru.0,"detail":ru.1}
    }})
}

fn policy(op: &str, a: &Value) -> Result<Value, String> {
    let text = |k: &str| a[k].as_str().unwrap_or("");
    let ru = a["language"] == "ru";
    let engine = a["kind"] == "engine";
    let id = text("id");
    Ok(match op {
        "flight" => json!(if a["active"] == true {
            if a["newListener"] != true {
                "join"
            } else if a["hasMessage"] == true {
                "replay"
            } else {
                "subscribe"
            }
        } else if a["downloaded"] == true {
            "ready"
        } else {
            "download"
        }),
        "publish" => json!(a["hint"] != a["previousHint"] || a["detail"] != a["previousDetail"]),
        "localize" => {
            let language = text("language");
            let copy = &a[language];
            if copy.is_object() && (copy["hint"] != a["hint"] || copy["detail"] != a["detail"]) {
                json!(language)
            } else {
                Value::Null
            }
        }
        "downloadStart" => json!({"retries":RETRIES,"status":status("downloading",
            ("Downloading model…","Downloading…"),("Загрузка модели…","Загрузка…"))}),
        "downloadNotice" => json!([
            if ru {
                format!("Скачиваю {id}. Прогресс смотри под полем ввода.")
            } else {
                format!("Downloading {id}. See progress below the input field.")
            },
            "info"
        ]),
        "ready" => status(
            "ready",
            ("Dictation ready", "Ready"),
            ("Диктовка готова", "Готова"),
        ),
        "failed" => status(
            "failed",
            ("Download failed · /voice-settings", text("detail")),
            ("Сбой загрузки · /voice-settings", text("detail")),
        ),
        "errorKind" => json!(if a["listener"] == true {
            "reported"
        } else {
            "original"
        }),
        "assetPlan" => match text("event") {
            "start" if engine => {
                json!({"action":"engineStatus","fromSettings":["downloadDir"],"options":{}})
            }
            "start" if a["platform"] == "win32" => {
                json!({"action":"recorderStatus","fromSettings":["downloadDir"],"options":{"skipFfmpegStaticInstall":true}})
            }
            "start" => json!({"action":"ready"}),
            "status" if a["resolved"] == true => json!({"action":"probe"}),
            "probe" if a["ok"] == true => json!({"action":"ready"}),
            "status" | "probe" => json!({"action":"install","retries":RETRIES}),
            event => return Err(format!("Unknown readiness event: {event}")),
        },
        "assetNotice" => match text("event") {
            "start" => json!([match (engine, ru) {
                (true, true) => format!("Установка {id}…"),
                (true, false) => format!("Installing {id}..."),
                (false, true) => "Установка программы записи для Windows…".into(),
                (false, false) => "Installing local Windows recorder...".into(),
            }]),
            "retry" => {
                let label = match (engine, ru) {
                    (true, true) => "Повтор установки движка",
                    (true, false) => "Engine install retry",
                    (false, true) => "Повтор установки программы записи",
                    (false, false) => "Recorder install retry",
                };
                json!([
                    format!(
                        "{label} {}/{}: {}",
                        text("next"),
                        text("attempts"),
                        text("error")
                    ),
                    "warning"
                ])
            }
            "done" => json!([
                match (engine, ru) {
                    (true, true) => format!("{id} установлен"),
                    (true, false) => format!("{id} installed"),
                    (false, true) => "Программа записи для Windows установлена".into(),
                    (false, false) => "Windows recorder installed".into(),
                },
                "success"
            ]),
            event => return Err(format!("Unknown install notice: {event}")),
        },
        _ => return Err(format!("Unknown readiness operation: {op}")),
    })
}

#[napi]
pub fn readiness(op: String, args: String) -> napi::Result<String> {
    crate::request(policy, &op, &args)
}

#[napi]
pub struct DownloadReadiness {
    bytes: f64,
    total: f64,
    last_update: f64,
}

impl Default for DownloadReadiness {
    fn default() -> Self {
        Self {
            bytes: 0.0,
            total: 0.0,
            last_update: f64::NEG_INFINITY,
        }
    }
}

#[napi]
impl DownloadReadiness {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn progress(&mut self, state: String, bytes: f64, total: f64, now: f64) -> String {
        match state.as_str() {
            "verifying" => json!({"clear":true,"status":status("verifying",("Verifying…","Verifying SHA256"),("Проверка…","Проверка SHA256"))}),
            "downloading" => {
                self.bytes=bytes;
                self.total=total;
                let wait=UPDATE_MS-(now-self.last_update);
                if wait<=0.0 {json!({"flush":true})}else{json!({"wait":wait})}
            }
            _=>json!({}),
        }.to_string()
    }

    #[napi]
    pub fn flush(&mut self, now: f64) -> napi::Result<String> {
        self.last_update = now;
        let counts = crate::download_counts(self.bytes, self.total)?;
        Ok(status(
            "downloading",
            (&format!("Downloading model{}", counts[2]), &counts[0]),
            (&format!("Загрузка модели{}", counts[3]), &counts[1]),
        )
        .to_string())
    }

    #[napi]
    pub fn retry(&mut self, next: String, attempts: String) -> napi::Result<String> {
        self.last_update = f64::NEG_INFINITY;
        let counts = crate::download_counts(self.bytes, self.total)?;
        let attempt = |i: usize| {
            if self.bytes != 0.0 && !self.bytes.is_nan() {
                format!("{next}/{attempts} · {}", counts[i])
            } else {
                format!("{next}/{attempts}")
            }
        };
        Ok(status(
            "downloading",
            (
                "Dictation · retrying download",
                &format!("Attempt {}", attempt(0)),
            ),
            (
                "Диктовка · повтор загрузки",
                &format!("Попытка {}", attempt(1)),
            ),
        )
        .to_string())
    }
}
