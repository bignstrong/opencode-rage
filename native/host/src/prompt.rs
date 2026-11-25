use napi_derive::napi;
use serde_json::{Value, json};

// Protocol values are OpenCode command IDs, not translated labels.
const COMMANDS: [[&str; 6]; 5] = [
    [
        "voice.record",
        "voice",
        "Voice: record",
        "Диктовка: записать",
        "Toggle dictation. Insert text in the prompt unless auto-submit is enabled.",
        "Начать или закончить диктовку. Без автоотправки текст появится в поле ввода.",
    ],
    [
        "voice.submit",
        "voice-submit",
        "Voice: submit",
        "Диктовка: записать и отправить",
        "Toggle local voice recording and submit after transcription.",
        "Начать или закончить запись и отправить распознанный текст.",
    ],
    [
        "voice.stop",
        "voice-stop",
        "Voice: stop",
        "Диктовка: отменить",
        "Cancel active voice recording or transcription.",
        "Отменить запись или распознавание.",
    ],
    [
        "voice.settings",
        "voice-settings",
        "Voice: settings",
        "Диктовка: настройки",
        "Open local voice input settings.",
        "Открыть настройки диктовки.",
    ],
    [
        "voice.orbs",
        "orbs",
        "Voice: choose indicator animation",
        "Диктовка: выбрать анимацию",
        "Change the indicator for agent responses and transcription.",
        "Сменить индикатор ответа агента и распознавания речи.",
    ],
];

#[napi]
pub fn command_rows(ru: bool, hotkey: String) -> String {
    let lang = usize::from(ru);
    let rows: Vec<_> = COMMANDS
        .iter()
        .map(|row| {
            let mut item = json!({"id":row[0], "title":row[2+lang], "description":row[4+lang],
            "group":if ru {"Диктовка"} else {"Voice"}, "palette":true,"slash":{"name":row[1]}});
            if row[0] == "voice.record" {
                item["slash"]["aliases"] = json!(["voice-record"]);
                item["bind"] = if hotkey.is_empty() {
                    Value::Bool(false)
                } else {
                    json!(hotkey)
                };
            }
            item
        })
        .collect();
    json!(rows).to_string()
}

#[napi]
pub fn orb_dialog(ru: bool, current: String) -> String {
    json!({
        "title": if ru {"Анимация индикатора"} else {"Indicator animation"},
        "placeholder": if ru {"Поиск"} else {"Search"},
        "current": current,
        "options": [
            {"value":"cycle","title":if ru {"Вдох и дождь"} else {"Breath and rain"}},
            {"value":"breath","title":if ru {"Цифровой вдох"} else {"Digital breath"}},
            {"value":"rain","title":if ru {"Цифровой дождь"} else {"Digital rain"}}
        ],
    })
    .to_string()
}

#[napi]
pub fn delivery_action(
    blank: bool,
    cancelled: bool,
    submit: bool,
    session: Option<String>,
    current_session: Option<String>,
) -> &'static str {
    if blank {
        "empty"
    } else if cancelled {
        "discard"
    } else if submit && session.is_some() && session == current_session {
        "submit"
    } else {
        "draft"
    }
}
