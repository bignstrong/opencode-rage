mod audio;
mod catalog;
mod cli;
mod external_wav;
mod install;
mod listen;
mod mac_inputs;
mod orbs;
mod recorder;
#[cfg(target_os = "macos")]
mod settings_migration;
mod speech;
mod training;
mod wake_detector;

use serde_json::{Value, json};
use std::{
    env,
    io::{self, Read, Write},
    path::Path,
    time::Duration,
};

fn send(value: Value) -> Result<(), String> {
    writeln!(io::stdout().lock(), "{value}").map_err(|e| e.to_string())
}

fn run(args: &[String]) -> Result<(), String> {
    match args {
        #[cfg(target_os = "macos")]
        [cmd, dir] if cmd == "migrate-settings" => send(json!(settings_migration::run(Path::new(dir))?)),
        [cmd, ..] if cmd == "migrate-settings" => Err("usage (macOS): rage-core migrate-settings /absolute/path/to/tui".into()),
        [cmd, op] if cmd == "asset" || (cmd == "recorder" && op == "probeRecorder") => {
            let mut body = String::new();
            io::stdin().take(1_048_577).read_to_string(&mut body).map_err(|e| e.to_string())?;
            if body.len() > 1_048_576 { return Err("asset request too large".into()); }
            let args = serde_json::from_str(&body).map_err(|e| e.to_string())?;
            let handler = if cmd == "asset" { install::request } else { recorder::request };
            send(json!({"result":handler(op,&args)?}))
        }
        [op, mode, seed, count] if op == "frames" => {
            let mut animation = orbs::Animation::new(mode, seed.parse().map_err(|_| "invalid seed")?)?;
            let count: usize = count.parse().map_err(|_| "invalid count")?;
            if count > 4096 { return Err("expected at most 4096 frames".into()); }
            send(json!((0..count).map(|_| animation.frame()).collect::<Vec<_>>()))
        }
        [op] if op == "devices" => send(json!(audio::devices()?)),
        [op, rest @ ..] if op == "listen" => listen::run(rest),
        [op] if op == "watch" => {
            let mut last = None;
            loop {
                let inputs = audio::devices()?;
                if last.as_ref() != Some(&inputs) {
                    send(json!(inputs))?;
                    last = Some(inputs);
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        [op, output, input @ ..] if op == "record" && input.len() <= 1 => {
            let (interrupted, training) = audio::record(input.first().map(String::as_str), Path::new(output))?;
            let mut event = json!({"event":"finished","interrupted":interrupted});
            match training {
                Some(Ok(id)) => event["training_id"] = json!(id),
                Some(Err(error)) => {
                    eprintln!("{error}");
                    event["training_error"] = json!(error);
                }
                None => {}
            }
            send(event)
        }
        [op, wav, lang, model @ ..] if op == "transcribe" && model.len() <= 1 => {
            let wav = Path::new(wav);
            let model = model.first().map(String::as_str);
            let result = speech::transcribe(wav, model, lang);
            let training_error = env::var("RAGE_TRAINING_TAKE_ID").ok()
                .zip(training::directory())
                .and_then(|(id, root)| training::finish_manual(&root, &id, wav, model, lang, &result).err())
                .map(training::failure);
            match (result, training_error) {
                (Ok(text), Some(error)) => {
                    eprintln!("{error}");
                    send(json!({"text": text, "training_error": error}))
                }
                (Ok(text), None) => send(json!(text)),
                (Err(error), None) => Err(error),
                (Err(asr), Some(error)) => Err(format!("{asr}; {error}")),
            }
        }
        [op, wav, lang, model @ ..] if op == "training-asr-timeout" && model.len() <= 1 => {
            let root = training::directory().ok_or("RAGE_TRAINING_DIR is not set")?;
            let id = env::var("RAGE_TRAINING_TAKE_ID").map_err(|_| "Missing training take ID")?;
            training::finish_manual(&root, &id, Path::new(wav), model.first().map(String::as_str), lang,
                &Err("Transcription timed out".into())).map_err(training::failure)
        }
        [op] if op == "ensure-model" => send(json!(speech::ensure_model()?)),
        _ => Err("usage: rage-core devices | watch | record WAV [INPUT] | transcribe WAV LANGUAGE [MODEL] | ensure-model".into()),
    }
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let status = match args.split_first() {
        Some((command, rest)) if command == "cli" => cli::run(rest),
        _ => run(&args).map(|_| 0),
    };
    if let Err(error) = status {
        eprintln!("{error}");
        std::process::exit(1);
    }
    std::process::exit(status.unwrap_or(1));
}
