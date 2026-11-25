use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const CORE: &str = env!("CARGO_BIN_EXE_rage-core");
const FILTER: &str = "highpass=f=180,adeclick,dynaudnorm=f=150:g=7,alimiter=limit=0.95";

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn decode(dir: &Path, wav: &Path, recover: bool, ffmpeg: &Path, filter: &str) -> Vec<u8> {
    let model = dir.join("fixture.bin");
    fs::write(&model, "model").unwrap();
    let cli = script(dir, "fake whisper", r#"cp "$4" "$COPY"; echo fixture"#);
    let scratch = dir.join("stt");
    fs::create_dir_all(&scratch).unwrap();
    let copy = dir.join("whisper-input");
    let out = Command::new(CORE)
        .arg("transcribe")
        .arg(wav)
        .arg("ru")
        .arg(model)
        .env("RAGE_RECOVER_WAV", if recover { "1" } else { "0" })
        .env("RAGE_FFMPEG", ffmpeg)
        .env("RAGE_CLEANUP_FILTER", filter)
        .env("RAGE_WHISPER", cli)
        .env("COPY", &copy)
        .env("TMPDIR", &scratch)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "\"fixture\"");
    assert_eq!(fs::read_dir(scratch).unwrap().count(), 0);
    fs::read(copy).unwrap()
}

#[test]
fn real_core_sigkill_preserves_verified_samples_including_pcm_after_last_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let wav = root.join("take.wav");
    let ffmpeg = script(
        root,
        "fixture recorder",
        r#"
cd "$FIXTURE"
case " $* " in *' -list_devices '*)
  printf "AVFoundation audio devices:\n[0] Fixture  [uid:1]\n" >&2; exit 1;;
esac
echo "[avfoundation @ 0x1] audio device 'Fixture' opened" >&2
printf '\001\002\003\004'
while [ ! -f release ]; do sleep 0.01; done
printf '\005\006\007'
touch tail
read -r command || :
"#,
    );
    let mut core = Command::new(CORE)
        .arg("record")
        .arg(&wav)
        .arg(":uid:1:Fixture")
        .env("RAGE_FFMPEG", &ffmpeg)
        .env("FIXTURE", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(core.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), r#"{"event":"ready"}"#);
    assert_eq!(fs::read(&wav).unwrap()[44..], [1, 2, 3, 4]);
    // Freeze the parent so the fake recorder's last write falls between checkpoints.
    assert!(
        Command::new("/bin/kill")
            .args(["-STOP", &core.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    fs::write(root.join("release"), "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !root.join("tail").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    core.kill().unwrap();
    assert!(!core.wait().unwrap().success());
    let raw = fs::read(&wav).unwrap();
    assert_eq!(&raw[44..], &[1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(fs::metadata(&wav).unwrap().permissions().mode() & 0o077, 0);
    let input = decode(root, &wav, true, &ffmpeg, "");
    assert_eq!(&input[44..], &[1, 2, 3, 4, 5, 6]);
    assert_eq!(&input[4..8], &42_u32.to_le_bytes());
    assert_eq!(&input[40..44], &6_u32.to_le_bytes());
    assert_eq!(fs::read(wav).unwrap(), raw, "repair must not mutate input");
}

#[test]
fn voice_cleanup_uses_host_filter_and_falls_back_to_raw_on_any_failure() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let input = vec![1; 48];
    let wav = root.join("original with spaces.wav");
    fs::write(&wav, &input).unwrap();
    let ffmpeg = script(
        root,
        "fixture cleaner",
        &format!(
            r#"
test "$5" = -i && test "$7" = -af && test "$8" = '{FILTER}'
test "$9" = -ar && test "${{10}}" = 16000 && test "${{12}}" = 1 && test "${{14}}" = pcm_s16le
cp "$6" "${{15}}"; printf '\002\003' >> "${{15}}"
"#
        ),
    );
    let cleaned = decode(root, &wav, false, &ffmpeg, FILTER);
    assert_eq!(cleaned, [input.as_slice(), &[2, 3]].concat());
    assert_eq!(decode(root, &wav, false, &ffmpeg, ""), input);
    for body in [
        "exit 1",
        "exit 0",
        "for out; do :; done; echo bad > \"$out\"",
    ] {
        let failed = script(root, "bad cleaner", body);
        assert_eq!(decode(root, &wav, false, &failed, FILTER), input);
    }
    assert_eq!(
        decode(root, &wav, false, &root.join("missing"), FILTER),
        input
    );
    assert_eq!(fs::read(wav).unwrap(), input);
}
