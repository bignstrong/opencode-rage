#[path = "../../src/catalog.rs"]
mod catalog;
mod composer;
mod decode;
pub use composer::{Drafts, Footer, FooterInput, activate_key, footer_view, release_button};
pub use decode::{DecodeInput, DecodePlan, decode_plan, decoder_command};
#[path = "../../../rust/formatters-rs/src/port.rs"]
mod formatters;
#[path = "../../src/install.rs"]
mod install;
mod layout;
pub use layout::dock_command_index;
#[path = "../../src/mac_inputs.rs"]
mod mac_inputs;
mod menu;
#[path = "../../src/orbs.rs"]
mod orbs;
mod picker;
mod prompt;
mod readiness;
pub use prompt::{command_rows, delivery_action, orb_dialog};
pub use readiness::{DownloadReadiness, readiness};
#[path = "../../src/preferences.rs"]
mod preferences;
#[path = "../../src/recorder.rs"]
mod recorder;
mod session;
use napi_derive::napi;

type Request = fn(&str, &serde_json::Value) -> Result<serde_json::Value, String>;

fn request(handler: Request, op: &str, args: &str) -> napi::Result<String> {
    let args = serde_json::from_str(args).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    handler(op, &args)
        .map(|v| v.to_string())
        .map_err(napi::Error::from_reason)
}

#[napi(js_name = "catalog")]
pub fn model_request(op: String, args: String) -> napi::Result<String> {
    request(catalog::request, &op, &args)
}

#[napi(js_name = "assetInfo")]
pub fn inspect_asset(op: String, args: String) -> napi::Result<String> {
    match op.as_str() {
        "getEnginePlatformKey"
        | "getManagedEngineDir"
        | "getManagedEngineBinary"
        | "getEngineManifestPath"
        | "readEngineManifest"
        | "getEngineStatus"
        | "getEngineRegistryUrl" => request(install::request, &op, &args),
        _ => Err(napi::Error::from_reason("Not a synchronous asset lookup")),
    }
}

#[napi(js_name = "recorderInfo")]
pub fn recorder_lookup(op: String, args: String) -> napi::Result<String> {
    if op == "probeRecorder" {
        return Err(napi::Error::from_reason(
            "Use the asynchronous recorder probe",
        ));
    }
    request(recorder::request, &op, &args)
}

#[napi]
pub fn mac_choices(list: String, strict: bool) -> napi::Result<Vec<String>> {
    let rows = if strict {
        mac_inputs::parse_list(&list)
    } else {
        mac_inputs::read_list(&list, false)
    };
    let mut values = Vec::new();
    for device in rows.map_err(napi::Error::from_reason)? {
        let value = device.selector();
        if !values.contains(&value) {
            values.push(value);
        }
    }
    Ok(values)
}

#[napi]
pub fn mac_input_label(value: String) -> String {
    if let Some(encoded) = value.strip_prefix(":uid:") {
        if let Some((uid, name)) = encoded.split_once(':')
            && !name.is_empty()
            && !uid.is_empty()
            && !name.contains(':')
            && mac_inputs::decode(uid).is_some()
            && let Some(name) = mac_inputs::decode(name)
        {
            return name;
        }
        return value;
    }
    value
        .strip_prefix("::")
        .or_else(|| value.strip_prefix(':'))
        .unwrap_or(&value)
        .to_owned()
}

#[napi]
pub fn picker_state(op: String, args: String) -> napi::Result<String> {
    request(picker::request, &op, &args)
}

#[napi]
pub fn menu_view(screen: String, args: String) -> napi::Result<String> {
    request(menu::request, &screen, &args)
}

#[napi(js_name = "preferences")]
pub fn settings_request(op: String, args: String) -> napi::Result<String> {
    request(preferences::request, &op, &args)
}

#[napi]
pub fn download_counts(bytes: f64, total: f64) -> napi::Result<Vec<String>> {
    let format = |n| formatters::format_bytes(n).map_err(napi::Error::from_reason);
    let received = format(bytes)?;
    let ru = |s: &str| s.replace("MB", "МБ").replace("GB", "ГБ").replace('.', ",");
    if total > 0.0 {
        let limit = format(total)?;
        let amount = format!(
            " {}%",
            ryu_js::Buffer::new().format((bytes / total * 100.0).floor())
        );
        return Ok(vec![
            format!("{received} / {limit}"),
            format!("{} / {}", ru(&received), ru(&limit)),
            amount.clone(),
            amount,
        ]);
    }
    let translated = ru(&received);
    Ok(vec![
        received.clone(),
        translated.clone(),
        format!(" · {received}"),
        format!(" · {translated}"),
    ])
}

#[napi]
pub fn progress_summary(percent: f64, rate: f64, eta: f64) -> napi::Result<Vec<String>> {
    [
        formatters::progress_line(percent),
        formatters::format_rate(rate),
        formatters::format_duration(eta),
    ]
    .into_iter()
    .collect::<Result<_, _>>()
    .map_err(napi::Error::from_reason)
}

#[napi]
pub struct Orb(orbs::Animation);

#[napi]
impl Orb {
    #[napi(constructor)]
    pub fn new(mode: String, seed: u32) -> napi::Result<Self> {
        orbs::Animation::new(&mode, seed)
            .map(Self)
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn frame(&mut self) -> String {
        self.0.frame()
    }
}
