//! Exercise the actual child/pipe lifecycle using a generated fake AVFoundation process.
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn fake() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("ffmpeg");
    fs::write(
        &script,
        r#"#!/bin/sh
cd "${0%/*}" || exit 1
case " $* " in
 *' -list_devices '*) cat inventory >&2; exit 1;;
esac
echo "$$" >> captures
printf '[avfoundation @ 0x1] [verbose] audio device '"'"'%s'"'"' opened\n' "$(cat open)" >&2
dd if=/dev/zero bs=320 count=1 2>/dev/null
exec sleep 30
"#,
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        dir.path().join("inventory"),
        "AVFoundation audio devices:\n[0] Fixture  [uid:abc]\n",
    )
    .unwrap();
    fs::write(dir.path().join("open"), "Fixture").unwrap();
    dir
}

fn launch(dir: &TempDir) -> Child {
    Command::new(env!("CARGO_BIN_EXE_rage-core"))
        .args([
            "listen",
            "--input",
            ":uid:abc:Fixture",
            "ru",
            "missing-model",
        ])
        .env("RAGE_FFMPEG", dir.path().join("ffmpeg"))
        .env_remove("RAGE_WAKE_PROFILE")
        .env("TMPDIR", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn exit(child: &mut Child, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if let Some(exit) = child.try_wait().unwrap() {
            return exit.success();
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            panic!("listener did not stop");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn invalid_selected_profile_does_not_open_input_or_use_builtin_examples() {
    let dir = fake();
    let mut child = Command::new(env!("CARGO_BIN_EXE_rage-core"))
        .args([
            "listen",
            "--input",
            ":uid:abc:Fixture",
            "ru",
            "missing-model",
        ])
        .env("RAGE_WAKE_PROFILE", dir.path())
        .env("RAGE_FFMPEG", dir.path().join("ffmpeg"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    assert!(!exit(&mut child, Duration::from_secs(3)));
    let out = child.wait_with_output().unwrap();
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Wake profile"));
    assert!(!dir.path().join("captures").exists());
}

#[test]
fn rejects_wrong_device_before_any_event() {
    let dir = fake();
    fs::write(dir.path().join("open"), "Other").unwrap();
    let mut child = launch(&dir);
    assert!(!exit(&mut child, Duration::from_secs(3)));
    let out = child.wait_with_output().unwrap();
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Different microphone"));
}

#[test]
fn eof_cancel_and_loss_close_the_only_stream_without_idle_files() {
    for control in ["eof", "cancel", "stop", "unplug", "scan error"] {
        let dir = fake();
        let mut child = launch(&dir);
        let mut events = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        events.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), r#"{"event":"waiting"}"#);
        let ids = fs::read_to_string(dir.path().join("captures")).unwrap();
        let id: i32 = ids.trim().parse().expect("exactly one capture");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 4);
        let lost = matches!(control, "unplug" | "scan error");
        if lost {
            let inventory = if control == "unplug" {
                "AVFoundation audio devices:\n[0] Fixture  [uid:replacement]\n"
            } else {
                "unreadable\n"
            };
            fs::write(dir.path().join("inventory"), inventory).unwrap();
        } else {
            let mut stdin = child.stdin.take().unwrap();
            if control != "eof" {
                writeln!(stdin, "{control}").unwrap();
                child.stdin = Some(stdin);
            }
        }
        assert_eq!(
            exit(&mut child, Duration::from_secs(if lost { 4 } else { 1 })),
            !lost,
            "{control}"
        );
        let mut tail = String::new();
        events.read_to_string(&mut tail).unwrap();
        assert!(tail.is_empty());
        // SAFETY: signal zero only probes existence of the former fixture PID.
        assert_eq!(unsafe { libc::kill(id, 0) }, -1);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 4);
    }
}

#[test]
fn wav_listener_reports_silence_sound_silence_without_writing_audio() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("meter.wav");
    let mut bytes =
        b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\0\0\0\0"
            .to_vec();
    for amplitude in [0i16, 1024, 0] {
        for i in 0..9600 {
            let sample = if i % 8 < 4 { amplitude } else { -amplitude };
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
    }
    let size = bytes.len() as u32;
    bytes[4..8].copy_from_slice(&(size - 8).to_le_bytes());
    bytes[40..44].copy_from_slice(&(size - 44).to_le_bytes());
    fs::write(&wav, bytes).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_rage-core"))
        .args(["listen", "--wav"])
        .arg(wav)
        .args(["ru", "missing-model"])
        .env_remove("RAGE_WAKE_PROFILE")
        .env("TMPDIR", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    assert!(exit(&mut child, Duration::from_secs(5)));
    let out = child.wait_with_output().unwrap();
    let events = String::from_utf8(out.stdout).unwrap();
    assert_eq!(
        events.lines().collect::<Vec<_>>(),
        [
            r#"{"event":"waiting"}"#,
            r#"{"event":"level","level":0}"#,
            r#"{"event":"level","level":2}"#,
            r#"{"event":"level","level":0}"#,
        ]
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires an existing Russian GigaAM model and engine; file synthesis only"]
fn real_asr_preserves_first_command_word_after_continuous_unrelated_speech() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("phrase.wav");
    assert!(
        Command::new("/usr/bin/say")
            .args([
                "-v",
                "Milena",
                "-r",
                "160",
                "--file-format=WAVE",
                "--data-format=LEI16@16000",
                "-o"
            ])
            .arg(&wav)
            .arg("Слушай Рейдж открой настройки")
            .status()
            .unwrap()
            .success()
    );
    // Pad the generated PCM with a real endpoint, respecting the synthesizer's metadata chunks.
    let bytes = fs::read(&wav).unwrap();
    let mut i = 12;
    loop {
        let n = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
        if &bytes[i..i + 4] == b"data" {
            let mut padded = bytes[..i + 8 + n].to_vec();
            padded.extend_from_slice(&[0; 48000]);
            let size = padded.len() as u32 - 8;
            padded[4..8].copy_from_slice(&size.to_le_bytes());
            padded[i + 4..i + 8].copy_from_slice(&(n as u32 + 48000).to_le_bytes());
            fs::write(&wav, padded).unwrap();
            break;
        }
        i += 8 + n + n % 2;
    }
    let model = std::env::var_os("RAGE_TEST_WAKE_MODEL").expect("RAGE_TEST_WAKE_MODEL");
    let mut child = Command::new(env!("CARGO_BIN_EXE_rage-core"))
        .args(["listen", "--wav"])
        .arg(&wav)
        .arg("ru")
        .arg(model)
        .env("TMPDIR", dir.path())
        .env("RAGE_ENGINE", "transcribe-cpp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    assert!(exit(&mut child, Duration::from_secs(40)));
    let events = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .map(|s| serde_json::from_str::<serde_json::Value>(&s.unwrap()).unwrap())
        .filter(|event| event["event"] != "level")
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(
        events[2]["text"].as_str().unwrap().to_lowercase(),
        "открой настройки."
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
