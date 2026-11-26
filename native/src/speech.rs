//! Local macOS speech engines. All children inherit the adapter's cancellation
//! process group; none inherit its stdin or its protocol stdout/stderr pipes.
use std::env;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};

const BASE: &str = "ggml-base.bin";
const EMPTY_TRANSCRIPT: &str = "Transcription returned empty text";
const SIZE: u64 = 147951465;
const SHA256: &str = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
const URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin";

fn io_error(error: io::Error) -> String {
    error.to_string()
}

fn setting(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

struct Cache {
    rage: PathBuf,
    voice: PathBuf,
}

impl Cache {
    fn locate() -> Result<Self, String> {
        let root = setting("XDG_CACHE_HOME")
            .filter(|p| p.is_absolute())
            .or_else(|| setting("HOME").map(|p| p.join(".cache")))
            .ok_or("Cannot locate model cache: set HOME or XDG_CACHE_HOME")?;
        let voice = match setting("OPENCODE_VOICE_DIR") {
            Some(p) if p.starts_with("~") => setting("HOME")
                .ok_or("HOME is missing")?
                .join(p.strip_prefix("~").map_err(|e| e.to_string())?),
            Some(p) => std::path::absolute(p).map_err(io_error)?,
            None => root.join("opencode-voice"),
        };
        Ok(Self {
            rage: root.join("rage/models"),
            voice,
        })
    }

    fn model(&self, selected: Option<&Path>) -> Result<Option<PathBuf>, String> {
        let base = self.rage.join(BASE);
        if let Some(path) = selected {
            let filename = if path.is_absolute() {
                None
            } else {
                Some(model_filename(path)?)
            };
            let candidates = match filename {
                Some(name) => vec![self.rage.join(&name), self.voice.join("models").join(name)],
                None => vec![path.to_owned()],
            };
            for p in candidates {
                if is_model_file(&p)? {
                    if p == base {
                        verify(&p, SIZE, SHA256)?;
                    }
                    return Ok(Some(p));
                }
            }
            return Err(format!("Selected model is missing: {}", path.display()));
        }
        if is_model_file(&base)? {
            verify(&base, SIZE, SHA256)?;
            return Ok(Some(base));
        }
        for name in [
            "ggml-large-v3-turbo-q5_0.bin",
            "ggml-large-v3-turbo.bin",
            "ggml-large-v3-q5_0.bin",
            BASE,
            "ggml-small.bin",
        ] {
            let p = self.voice.join("models").join(name);
            if is_model_file(&p)? {
                return Ok(Some(p));
            }
        }
        Ok(None)
    }
}

fn model_filename(path: &Path) -> Result<PathBuf, String> {
    if path.file_name() == Some(path.as_os_str()) && supported(path) {
        return Ok(path.to_owned());
    }
    let id = path.to_str().and_then(|s| s.strip_prefix("whisper-"));
    let name = match id {
        Some("turbo") => "ggml-large-v3-turbo.bin".into(),
        Some("turbo-q5_0") => "ggml-large-v3-turbo-q5_0.bin".into(),
        Some("large-q5_0") => "ggml-large-v3-q5_0.bin".into(),
        Some("medium-q4_1") => "whisper-medium-q4_1.bin".into(),
        Some(id @ ("tiny-en" | "base-en" | "small-en" | "medium-en")) => {
            format!("ggml-{}.en.bin", id.trim_end_matches("-en"))
        }
        Some(
            id @ ("tiny" | "tiny-q5_1" | "base" | "base-q5_1" | "small" | "small-q5_1" | "medium"
            | "medium-q5_0" | "large-v1" | "large-v2" | "large-v3"),
        ) => format!("ggml-{id}.bin"),
        _ => {
            return Err(format!(
                "Unknown model '{}'; pass the selected catalog file's absolute .bin or .gguf path",
                path.display()
            ));
        }
    };
    Ok(PathBuf::from(name))
}

fn supported(p: &Path) -> bool {
    matches!(p.extension().and_then(OsStr::to_str), Some("bin" | "gguf"))
}

fn is_model_file(p: &Path) -> Result<bool, String> {
    if !supported(p) {
        return Err(format!("Expected a .bin or .gguf model: {}", p.display()));
    }
    match fs::metadata(p) {
        Ok(m) if m.is_file() && m.len() > 0 => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Ok(_) => Err(format!("Invalid or empty model at {}", p.display())),
        Err(e) => Err(format!("Cannot inspect {}: {e}", p.display())),
    }
}

fn selection(model: Option<&str>) -> Option<PathBuf> {
    model
        .filter(|s| !s.is_empty() && *s != "default")
        .map(PathBuf::from)
        .or_else(|| setting("RAGE_MODEL").filter(|p| p != Path::new("default")))
}

fn verify(p: &Path, bytes: u64, sha256: &str) -> Result<(), String> {
    let file = File::open(p).map_err(io_error)?;
    if file.metadata().map_err(io_error)?.len() == bytes {
        let hash = Command::new("/usr/bin/openssl")
            .args(["dgst", "-sha256", "-r"])
            .stdin(file)
            .output()
            .map_err(io_error)?;
        if hash.status.success()
            && String::from_utf8_lossy(&hash.stdout)
                .split_whitespace()
                .next()
                == Some(sha256)
        {
            return Ok(());
        }
    }
    Err(format!("Model integrity check failed: {}", p.display()))
}

pub fn ensure_model() -> Result<String, String> {
    let cache = Cache::locate()?;
    let path = match cache.model(selection(None).as_deref())? {
        Some(path) => path,
        None => {
            fs::create_dir_all(&cache.rage).map_err(io_error)?;
            let tmp = tempfile::NamedTempFile::new_in(&cache.rage).map_err(io_error)?;
            let output = Command::new("/usr/bin/curl")
                .args([
                    "--disable",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--location",
                    "--proto",
                    "=https",
                    "--proto-redir",
                    "=https",
                    "--connect-timeout",
                    "15",
                    "--max-time",
                    "900",
                    "--max-filesize",
                    &SIZE.to_string(),
                    "--output",
                ])
                .arg(tmp.path())
                .arg(URL)
                .stdin(Stdio::null())
                .output()
                .map_err(io_error)?;
            if !output.status.success() {
                return Err(format!(
                    "Model download failed ({}): {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            verify(tmp.path(), SIZE, SHA256)?;
            let dest = cache.rage.join(BASE);
            match tmp.persist_noclobber(&dest) {
                Ok(_) => (),
                Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => {
                    verify(&dest, SIZE, SHA256)?
                }
                Err(e) => return Err(e.to_string()),
            }
            dest
        }
    };
    path.into_os_string()
        .into_string()
        .map_err(|_| "Model path is not UTF-8".into())
}

fn executable(cache: &Cache, gguf: bool) -> PathBuf {
    let (engine, bin, configured) = if gguf {
        (
            "transcribe-cpp",
            "opencode-voice-transcribe",
            setting("OPENCODE_VOICE_TRANSCRIBE_CPP"),
        )
    } else {
        (
            "whisper.cpp",
            "whisper-cli",
            setting("RAGE_WHISPER")
                .or_else(|| setting("RAGE_WHISPER_CLI"))
                .or_else(|| setting("OPENCODE_VOICE_WHISPER_CLI")),
        )
    };
    configured.unwrap_or_else(|| {
        let arch = if cfg!(target_arch = "aarch64") {
            "darwin-arm64"
        } else {
            "darwin-x64"
        };
        let path = cache
            .voice
            .join("engines")
            .join(engine)
            .join(arch)
            .join(bin);
        if path.is_file() { path } else { bin.into() }
    })
}

fn captured(mut file: File, limit: u64) -> Result<String, String> {
    file.rewind().map_err(io_error)?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > limit {
        return Err("Speech engine output exceeds limit".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn sidecar(model: &Path) -> bool {
    match env::var("RAGE_ENGINE").as_deref() {
        Ok("transcribe-cpp") => true,
        Ok("whisper.cpp") => false,
        _ => model.extension() == Some(OsStr::new("gguf")),
    }
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

type Pump<'a> = Option<&'a mut dyn FnMut() -> Result<(), String>>;

fn wait(child: Child, pump: Pump<'_>) -> Result<ExitStatus, String> {
    let mut child = Running(child);
    if let Some(pump) = pump {
        loop {
            pump()?;
            if let Some(status) = child.0.try_wait().map_err(io_error)? {
                return Ok(status);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    child.0.wait().map_err(io_error)
}

fn recognize(cli: &Path, model: &Path, wav: &Path, language: &str) -> Result<String, String> {
    recognize_with(cli, model, wav, language, Stdio::null(), None)
}

fn recognize_with(
    cli: &Path,
    model: &Path,
    wav: &Path,
    language: &str,
    input: Stdio,
    pump: Pump<'_>,
) -> Result<String, String> {
    let mut command = Command::new(cli);
    let gguf = sidecar(model);
    if gguf {
        command.arg("--model").arg(model).arg("--file").arg(wav);
    } else {
        command
            .arg("-m")
            .arg(model)
            .arg("-f")
            .arg(wav)
            .args(["-np", "-nt"]);
    }
    if !gguf || (!language.is_empty() && language != "auto") {
        command.args([
            if gguf { "--language" } else { "-l" },
            if language.is_empty() {
                "auto"
            } else {
                language
            },
        ]);
    }
    // Unlinked files keep transcripts private even on SIGKILL, and waiting for
    // the direct child never blocks on pipe handles inherited by grandchildren.
    let stdout = tempfile::tempfile().map_err(io_error)?;
    let stderr = tempfile::tempfile().map_err(io_error)?;
    let child = command
        .stdin(input)
        .stdout(stdout.try_clone().map_err(io_error)?)
        .stderr(stderr.try_clone().map_err(io_error)?)
        .spawn()
        .map_err(|e| format!("Cannot start {}: {e}", cli.display()))?;
    let status = wait(child, pump)?;
    let log = captured(stderr, 4 * 1024 * 1024)?;
    let error = log
        .lines()
        .map(str::trim)
        .find(|s| s.to_ascii_lowercase().starts_with("error:"));
    if !status.success() || error.is_some() {
        let detail = error
            .or_else(|| log.lines().last())
            .unwrap_or("")
            .chars()
            .take(400)
            .collect::<String>();
        return Err(format!("Speech engine failed ({status}): {detail}"));
    }
    let text = captured(stdout, 4 * 1024 * 1024)?;
    let text = clean_text(&text);
    if text.is_empty() {
        return Err(EMPTY_TRANSCRIPT.into());
    }
    Ok(text)
}

fn clean_text(text: &str) -> String {
    fn strip(mut src: &str, open: char, close: char) -> String {
        let mut out = String::new();
        while let Some((prefix, rest)) = src.split_once(open) {
            let Some((_, after)) = rest.split_once(close) else {
                break;
            };
            out.push_str(prefix);
            out.push(' ');
            src = after;
        }
        out.push_str(src);
        out
    }
    strip(&strip(text, '[', ']'), '(', ')')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn filtered_wav(wav: &Path, ffmpeg: &Path, filter: &OsStr) -> Option<tempfile::NamedTempFile> {
    let out = tempfile::Builder::new().suffix(".wav").tempfile().ok()?;
    let status = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(wav)
        .arg("-af")
        .arg(filter)
        .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
        .arg(out.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    (status.success() && out.as_file().metadata().ok()?.len() > 44).then_some(out)
}

fn wake_has_acoustic_support(wav: &mut File) -> io::Result<bool> {
    // Inspect the actual decoder input, including cleanup. This WAV is always
    // our fixed header followed by mono 16 kHz PCM, not an external WAV.
    const HEADER_BYTES: u64 = 44;
    let mut frame = [0u8; 320];
    let frames = wav.metadata()?.len().saturating_sub(HEADER_BYTES) / frame.len() as u64;
    wav.seek(io::SeekFrom::Start(HEADER_BYTES))?;
    let mut reader = io::BufReader::new(wav);
    let mut supported = 0;
    for _ in 0..frames {
        reader.read_exact(&mut frame)?;
        let pcm = std::array::from_fn::<_, 160, _>(|i| {
            i32::from(i16::from_le_bytes([frame[2 * i], frame[2 * i + 1]]))
        });
        let mean = pcm.iter().sum::<i32>() / 160;
        let energy: i64 = pcm.iter().map(|s| i64::from(s - mean).pow(2)).sum();
        let crossings = pcm
            .windows(2)
            .filter(|p| (p[0] < mean) != (p[1] < mean))
            .count();
        // At least 100 ms of low-level acoustic evidence, not necessarily
        // contiguous. Centering excludes DC; white hiss crosses near 50%.
        if energy >= 160 * 32 * 32 && crossings < 56 {
            supported += 1;
            if supported == 10 {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// ASR scratch files, including filter output, are unlinked. Dataset copies are handled by the caller.
/// /dev/fd/0 exposes the inherited seekable WAV to both supported macOS engines.
pub(crate) fn transcribe_turn(
    samples: &[i16],
    model: &str,
    language: &str,
    mut pump: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    pump()?;
    let cache = Cache::locate()?;
    let model = cache
        .model(selection(Some(model)).as_deref())?
        .ok_or("No Whisper model installed; install the default model or select a model path")?;
    let gguf = sidecar(&model);
    let cli = executable(&cache, gguf);
    let mut wav = tempfile::tempfile().map_err(io_error)?;
    wav.write_all(&crate::audio::wav_header(2 * samples.len() as u64)?)
        .map_err(io_error)?;
    {
        let mut out = io::BufWriter::new(&mut wav);
        for sample in samples {
            out.write_all(&sample.to_le_bytes()).map_err(io_error)?;
        }
        out.flush().map_err(io_error)?;
    }
    wav.rewind().map_err(io_error)?;
    if let Some((ffmpeg, filter)) =
        setting("RAGE_FFMPEG").zip(env::var_os("RAGE_CLEANUP_FILTER").filter(|v| !v.is_empty()))
    {
        let mut cleaned = tempfile::tempfile().map_err(io_error)?;
        cleaned
            .write_all(&crate::audio::wav_header(0)?)
            .map_err(io_error)?;
        let cmd = Command::new(ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-af",
            ])
            .arg(filter)
            .args(["-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"])
            .stdin(wav.try_clone().map_err(io_error)?)
            .stdout(cleaned.try_clone().map_err(io_error)?)
            .stderr(Stdio::null())
            .spawn();
        if let Ok(child) = cmd
            && wait(child, Some(&mut pump))?.success()
        {
            let bytes = cleaned.metadata().map_err(io_error)?.len() - 44;
            if bytes > 0 && bytes.is_multiple_of(2) {
                cleaned.rewind().map_err(io_error)?;
                cleaned
                    .write_all(&crate::audio::wav_header(bytes)?)
                    .map_err(io_error)?;
                wav = cleaned;
            }
        }
    }
    pump()?;
    if !gguf && !wake_has_acoustic_support(&mut wav).map_err(io_error)? {
        return Err(EMPTY_TRANSCRIPT.into());
    }
    wav.rewind().map_err(io_error)?;
    recognize_with(
        &cli,
        &model,
        Path::new("/dev/fd/0"),
        language,
        wav.into(),
        Some(&mut pump),
    )
}

pub fn transcribe(wav: &Path, model: Option<&str>, language: &str) -> Result<String, String> {
    let wav = wav
        .canonicalize()
        .map_err(|e| format!("Cannot open audio {}: {e}", wav.display()))?;
    if !wav.is_file() {
        return Err(format!("Not an audio file: {}", wav.display()));
    }
    let cache = Cache::locate()?;
    let model = cache
        .model(selection(model).as_deref())?
        .ok_or("No Whisper model installed; install the default model or select a model path")?;
    let cli = executable(&cache, sidecar(&model));
    let recovered = match env::var("RAGE_RECOVER_WAV").as_deref() {
        Ok("1") => crate::audio::recovered_wav(&wav)?,
        Ok("external") => Some(crate::external_wav::copy(&wav).map_err(io_error)?),
        _ => None,
    };
    let raw = recovered.as_ref().map_or(wav.as_path(), |f| f.path());
    let cleaned = setting("RAGE_FFMPEG")
        .zip(env::var_os("RAGE_CLEANUP_FILTER").filter(|v| !v.is_empty()))
        .and_then(|(ffmpeg, filter)| filtered_wav(raw, &ffmpeg, &filter));
    recognize(
        &cli,
        &model,
        cleaned.as_ref().map_or(raw, |f| f.path()),
        language,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn noise(samples: usize) -> Vec<i16> {
        let mut state = 42u32;
        (0..samples)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 16) % 10_001) as i16 - 5000
            })
            .collect()
    }

    #[test]
    fn wake_gate_rejects_silence_dc_and_hiss_but_accepts_short_quiet_signal() {
        let viable = |samples: &[i16]| {
            let mut wav = tempfile::tempfile().unwrap();
            wav.write_all(&crate::audio::wav_header(samples.len() as u64 * 2).unwrap())
                .unwrap();
            for s in samples {
                wav.write_all(&s.to_le_bytes()).unwrap();
            }
            wake_has_acoustic_support(&mut wav).unwrap()
        };
        assert!(!viable(&[]));
        assert!(!viable(&[0; 1600]));
        assert!(!viable(&[5000; 1600]));
        assert!(!viable(&noise(48_000)));
        let mut quiet = noise(9600);
        for (i, s) in quiet[1600..3200].iter_mut().enumerate() {
            *s = *s / 400 + if i % 80 < 40 { 50 } else { -50 };
        }
        assert!(viable(&quiet));
    }

    #[test]
    fn selected_model_never_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache {
            rage: dir.path().join("rage"),
            voice: dir.path().join("voice"),
        };
        let models = cache.voice.join("models");
        fs::create_dir_all(&models).unwrap();
        let turbo = models.join("ggml-large-v3-turbo-q5_0.bin");
        fs::write(&turbo, "fixture").unwrap();
        assert_eq!(cache.model(None).unwrap().as_deref(), Some(turbo.as_path()));
        assert_eq!(
            cache.model(Some(Path::new("whisper-turbo-q5_0"))).unwrap(),
            Some(turbo)
        );
        for bad in ["whisper-turbo", "unrecognized", "../elsewhere.bin"] {
            assert!(cache.model(Some(Path::new(bad))).is_err());
        }
    }

    #[test]
    fn same_size_corrupt_model_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("model.bin");
        let hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        fs::write(&file, "abc").unwrap();
        verify(&file, 3, hash).unwrap();
        fs::write(&file, "xyz").unwrap();
        assert!(verify(&file, 3, hash).is_err());
    }

    #[test]
    fn engine_contracts_and_zero_exit_error() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("fixture engine");
        let wav = Path::new("/example with spaces.wav");
        let run = |script: &str, ext: &str, lang: &str| {
            fs::write(&cli, format!("#!/bin/sh\nset -eu\n{script}")).unwrap();
            fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
            recognize(&cli, Path::new(ext), wav, lang)
        };
        assert_eq!(run(r#"test "$#" = 8 && test "$1" = -m && test "$2" = exact.bin && test "$3" = -f && test "$4" = '/example with spaces.wav' && test "$5" = -np && test "$6" = -nt && test "$7" = -l && test "$8" = ru || exit 2
printf ' [music] один\n (noise) два \n'"#, "exact.bin", "ru").unwrap(), "один два");
        assert_eq!(
            run("test \"$#\" = 4; echo hello", "exact.gguf", "auto").unwrap(),
            "hello"
        );
        assert!(
            run(
                "echo 'error: unreadable audio' >&2; exit 0",
                "exact.bin",
                ""
            )
            .unwrap_err()
            .contains("unreadable audio")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a locally installed speech engine and model"]
    fn recognizes_synthesized_speech() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("test.wav");
        let status = Command::new("/usr/bin/say")
            .args(["--file-format=WAVE", "--data-format=LEI16@16000", "-o"])
            .arg(&wav)
            .arg("The quick brown fox jumps over the lazy dog.")
            .status()
            .unwrap();
        assert!(status.success());
        let text = transcribe(&wav, None, "en").unwrap().to_lowercase();
        assert!(
            text.contains("quick brown fox") && text.contains("lazy dog"),
            "{text}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires installed Milena voice and Whisper Turbo Q5_0 model/engine"]
    fn wake_whisper_rejects_noise_but_preserves_spoken_russian() {
        let model = "whisper-turbo-q5_0";
        let no_text = Err(EMPTY_TRANSCRIPT.into());
        assert_eq!(
            transcribe_turn(&vec![0; 48_000], model, "ru", || Ok(())),
            no_text
        );
        assert_eq!(
            transcribe_turn(&noise(48_000), model, "ru", || Ok(())),
            no_text
        );

        let dir = tempfile::tempdir().unwrap();
        for (text, expected, degraded) in [
            ("Да.", "да", false),
            (
                "Проверь состояние сервера.",
                "проверь состояние сервера",
                true,
            ),
            (
                "Редактор субтитров Александр Семкин, корректор Анна Егорова.",
                "редактор субтитров александр семкин, корректор анна егорова",
                false,
            ),
        ] {
            let path = dir.path().join("synth.wav");
            assert!(
                Command::new("/usr/bin/say")
                    .args([
                        "-v",
                        "Milena",
                        "--file-format=WAVE",
                        "--data-format=LEI16@16000",
                        "-o"
                    ])
                    .arg(&path)
                    .arg(text)
                    .status()
                    .unwrap()
                    .success()
            );
            let wav = fs::read(&path).unwrap();
            let mut chunks = &wav[12..];
            let mut pcm = loop {
                let len = u32::from_le_bytes(chunks[4..8].try_into().unwrap()) as usize;
                if &chunks[..4] == b"data" {
                    break chunks[8..8 + len]
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|&s| i16::from_le_bytes(s))
                        .collect::<Vec<_>>();
                }
                chunks = &chunks[8 + len + len % 2..];
            };
            let manual = transcribe(&path, Some(model), "ru").unwrap().to_lowercase();
            assert_eq!(manual.trim_end_matches(['.', '!', '?']), expected);
            fs::remove_file(path).unwrap();
            if degraded {
                for (s, n) in pcm.iter_mut().zip(noise(48_000)) {
                    *s = *s / 8 + n / 70;
                }
            }
            pcm.extend([0; 16_000]);
            let wake = transcribe_turn(&pcm, model, "ru", || Ok(()))
                .unwrap()
                .to_lowercase();
            assert_eq!(wake.trim_end_matches(['.', '!', '?']), expected);
        }
    }
}
