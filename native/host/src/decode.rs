use napi_derive::napi;
use serde_json::json;

#[napi(object)]
pub struct DecodeInput {
    pub engine: String,
    pub model_name: String,
    pub model_path: String,
    pub binary: Option<String>,
    pub language: Option<String>,
    pub timeout_ms: f64,
    pub cleanup: bool,
    pub cutoff_hz: Option<f64>,
    pub interrupted: Option<bool>,
}

#[napi(object)]
pub struct DecodePlan {
    pub engine_key: String,
    pub binary: String,
    pub language: String,
    pub timeout_ms: f64,
    pub cleanup_filter: String,
    pub recover_wav: String,
}

#[napi]
pub fn decoder_command(engine: String) -> String {
    command(&engine).into()
}

fn command(engine: &str) -> &'static str {
    if engine == "transcribe-cpp" {
        "opencode-voice-transcribe"
    } else {
        "whisper-cli"
    }
}

#[napi]
pub fn decode_plan(input: DecodeInput) -> napi::Result<DecodePlan> {
    let binary = input.binary.filter(|s| !s.is_empty()).ok_or_else(|| {
        napi::Error::from_reason(format!(
            "{} not found. Install the managed {} engine or set its OPENCODE_VOICE_* binary path.",
            command(&input.engine),
            input.engine
        ))
    })?;
    if !std::path::Path::new(&input.model_path).exists() {
        return Err(napi::Error::from_reason(format!(
            "Model is not downloaded: {}",
            input.model_name
        )));
    }
    let filter = crate::preferences::request(
        "buildFilterChain",
        &json!({
            "enabled": input.cleanup, "cutoffHz": input.cutoff_hz
        }),
    )
    .map_err(napi::Error::from_reason)?;
    Ok(DecodePlan {
        engine_key: if input.engine == "transcribe-cpp" {
            "OPENCODE_VOICE_TRANSCRIBE_CPP"
        } else {
            "RAGE_WHISPER"
        }
        .into(),
        binary,
        language: input
            .language
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "auto".into()),
        timeout_ms: if input.timeout_ms == 0. || input.timeout_ms.is_nan() {
            120_000.
        } else {
            input.timeout_ms
        },
        cleanup_filter: filter.as_str().unwrap_or("").into(),
        recover_wav: match input.interrupted {
            None => "external",
            Some(true) => "1",
            Some(false) => "0",
        }
        .into(),
    })
}
