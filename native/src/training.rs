//! Opt-in local dataset. `meta.json` is the commit marker; readers skip takes without it.
use crate::audio::wav_header;
use serde_json::{Value, json};
use std::{
    fs::{self, DirBuilder, File, OpenOptions, Permissions},
    io::{self, BufWriter, Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
};
use tempfile::TempDir;

pub(crate) fn collection_directory() -> Option<PathBuf> {
    if std::env::var_os("RAGE_SAVE_TAKES").is_some_and(|value| value == "0") {
        return None;
    }
    std::env::var_os("RAGE_TRAINING_DIR")
        .filter(|v| !v.is_empty())
        .map(|path| Path::new(&path).components().collect())
}

pub(crate) fn failure(error: impl std::fmt::Display) -> String {
    format!("RAGE_TRAINING_DIR: could not save training take: {error}")
}

fn private_dir(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "use a private directory owned by the recording user (chmod 700); no symlink",
        ));
    }
    Ok(())
}

fn require_absolute(root: &Path) -> io::Result<()> {
    if root.is_absolute() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected an absolute directory path",
        ))
    }
}

fn asr(result: &Result<String, String>) -> (&str, Option<&str>, Option<&str>) {
    match result {
        Ok(text) if !text.trim().is_empty() => ("ok", Some(text.as_str()), None),
        Ok(_) => ("empty", None, None),
        Err(e) if e == "Transcription returned empty text" => ("empty", None, None),
        Err(e) => ("error", None, Some(e.as_str())),
    }
}

fn model_id(model: &str) -> Option<&str> {
    // Keep a model identifier, not an absolute path containing the user's name.
    Path::new(model)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| *name != "default")
}

fn metadata_file(dir: &Path, meta: &Value) -> io::Result<tempfile::NamedTempFile> {
    let mut file = tempfile::Builder::new()
        .permissions(Permissions::from_mode(0o600))
        .tempfile_in(dir)?;
    serde_json::to_writer_pretty(&mut file, meta)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    Ok(file)
}

pub(crate) struct Take {
    dir: TempDir,
    sample_count: u64,
}

impl Take {
    fn new(root: &Path, sample_count: u64) -> io::Result<Self> {
        require_absolute(root)?;
        DirBuilder::new().recursive(true).mode(0o700).create(root)?;
        private_dir(root)?;
        Ok(Self {
            dir: tempfile::Builder::new()
                .prefix("take-")
                .rand_bytes(16)
                .permissions(Permissions::from_mode(0o700))
                .tempdir_in(root)?,
            sample_count,
        })
    }

    fn audio(&self) -> io::Result<File> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.dir.path().join("audio.wav"))
    }

    pub(crate) fn wake(root: &Path, samples: &[i16]) -> io::Result<Self> {
        let take = Self::new(root, samples.len() as u64)?;
        let file = take.audio()?;
        let mut out = BufWriter::new(&file);
        out.write_all(&wav_header(2 * take.sample_count).map_err(io::Error::other)?)?;
        for sample in samples {
            out.write_all(&sample.to_le_bytes())?;
        }
        out.flush()?;
        file.sync_all()?;
        Ok(take)
    }

    pub(crate) fn finish_wake(
        self,
        model: &str,
        language: &str,
        result: &Result<String, String>,
        crop: Value,
    ) -> io::Result<String> {
        let (status, asr_text, asr_error) = asr(result);
        self.finish(json!({
            "source": "wake", "status": status, "asr_text": asr_text, "asr_error": asr_error,
            "model": model_id(model),
            "language": Some(language).filter(|lang| !lang.is_empty()),
            "asr_crop": crop,
        }))
    }

    fn finish(self, mut meta: Value) -> io::Result<String> {
        meta["schema_version"] = json!(1);
        meta["reference_text"] = Value::Null;
        meta["sample_rate_hz"] = json!(16_000);
        meta["sample_count"] = json!(self.sample_count);
        let id = self
            .dir
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| io::Error::other("invalid training take directory"))?
            .to_owned();
        metadata_file(self.dir.path(), &meta)?
            .persist_noclobber(self.dir.path().join("meta.json"))
            .map_err(|e| e.error)?;
        let _ = self.dir.keep();
        Ok(id)
    }
}

fn regular_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a regular file",
        ));
    }
    Ok(file)
}

fn identity(meta: &fs::Metadata) -> String {
    format!("{}:{}", meta.dev(), meta.ino())
}

pub(crate) fn manual(root: &Path, wav: &Path) -> io::Result<String> {
    let mut input = regular_file(wav)?;
    let meta = input.metadata()?;
    let mut header = [0; 44];
    input.read_exact(&mut header)?;
    let bytes = meta.len().saturating_sub(header.len() as u64);
    if bytes == 0 || bytes % 2 != 0 || header != wav_header(bytes).map_err(io::Error::other)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid captured PCM WAV",
        ));
    }
    let take = Take::new(root, bytes / 2)?;
    let mut out = take.audio()?;
    out.write_all(&header)?;
    if io::copy(&mut input.take(bytes), &mut out)? != bytes {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "incomplete captured PCM WAV",
        ));
    }
    out.sync_all()?;
    take.finish(json!({
        "source": "manual", "status": "not_run", "asr_text": null, "asr_error": null,
        "model": null, "language": null, "asr_crop": null,
        "capture_file_id": identity(&meta),
    }))
}

pub(crate) fn finish_manual(
    root: &Path,
    id: &str,
    wav: &Path,
    model: Option<&str>,
    language: &str,
    result: &Result<String, String>,
) -> io::Result<()> {
    require_absolute(root)?;
    let valid = id.strip_prefix("take-").is_some_and(|suffix| {
        suffix.len() == 16 && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
    });
    if !valid {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid training take ID",
        ));
    }
    private_dir(root)?;
    let dir = root.join(id);
    private_dir(&dir)?;
    let audio = regular_file(&dir.join("audio.wav"))?;
    // SAFETY: audio owns a live fd. Closing it also releases this advisory lock.
    if unsafe { libc::flock(audio.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let path = dir.join("meta.json");
    let mut meta: Value = serde_json::from_reader(regular_file(&path)?)?;
    if meta["source"] != "manual"
        || meta["capture_file_id"] != identity(&regular_file(wav)?.metadata()?)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "training ID does not match this manual capture",
        ));
    }
    if meta["status"] != "not_run" {
        return Ok(());
    }
    let (status, text, error) = asr(result);
    meta["status"] = json!(status);
    meta["asr_text"] = json!(text);
    meta["asr_error"] = json!(error);
    meta["model"] = json!(model.and_then(model_id));
    meta["language"] = json!(Some(language).filter(|lang| !lang.is_empty()));
    metadata_file(&dir, &meta)?
        .persist(path)
        .map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect()
    }

    fn generated_wav() -> Vec<u8> {
        [wav_header(4).unwrap().as_slice(), &[0, 128, 255, 127]].concat()
    }

    fn metadata(take: &Path) -> Value {
        serde_json::from_reader(File::open(take.join("meta.json")).unwrap()).unwrap()
    }

    #[test]
    fn manual_training_keeps_exact_wav_and_has_no_reference_or_asr() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("private/training");
        let wav = home.path().join("generated.wav");
        fs::write(&wav, generated_wav()).unwrap();
        manual(&root, &wav).unwrap();
        let entries = entries(&root);
        let take = &entries[0];
        assert_eq!(entries.len(), 1);
        assert_eq!(fs::read(take.join("audio.wav")).unwrap(), generated_wav());
        assert_eq!(
            metadata(take),
            json!({
                "schema_version": 1, "source": "manual", "status": "not_run",
                "asr_text": null, "reference_text": null, "asr_error": null,
                "language": null, "model": null, "asr_crop": null,
                "sample_rate_hz": 16_000, "sample_count": 2,
                "capture_file_id": identity(&fs::metadata(&wav).unwrap()),
            }),
        );
        for dir in [root.as_path(), root.parent().unwrap(), take] {
            assert_eq!(fs::metadata(dir).unwrap().mode() & 0o777, 0o700);
        }
        for file in ["audio.wav", "meta.json"] {
            assert_eq!(fs::metadata(take.join(file)).unwrap().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn manual_asr_updates_only_its_own_capture_and_leaves_reference_separate() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("training");
        let wav = home.path().join("capture.wav");
        let external = home.path().join("external.wav");
        fs::write(&wav, generated_wav()).unwrap();
        fs::write(&external, generated_wav()).unwrap();
        assert!(manual(Path::new("relative"), &wav).is_err());
        let id = manual(&root, &wav).unwrap();
        let take = root.join(&id);
        let label = take.join("reference.json");
        fs::write(&label, b"human").unwrap();
        let model = Some("/private/base.bin");
        let text = Ok("гипотеза".into());
        assert!(finish_manual(&root, &id, &external, model, "ru", &text).is_err());
        assert!(finish_manual(&root, "../escape", &wav, model, "ru", &text).is_err());
        assert_eq!(metadata(&take)["status"], "not_run");
        finish_manual(&root, &id, &wav, model, "ru", &text).unwrap();
        finish_manual(&root, &id, &wav, model, "ru", &Err("late error".into())).unwrap();
        let meta = metadata(&take);
        assert_eq!(meta["status"], "ok");
        assert_eq!(meta["asr_text"], "гипотеза");
        assert_eq!(meta["reference_text"], Value::Null);
        assert_eq!(meta["model"], "base.bin");
        assert_eq!(meta["language"], "ru");
        assert_eq!(fs::read(&label).unwrap(), b"human");
        let failed = manual(&root, &wav).unwrap();
        finish_manual(
            &root,
            &failed,
            &wav,
            model,
            "ru",
            &Err("engine failed".into()),
        )
        .unwrap();
        assert_eq!(metadata(&root.join(failed))["asr_error"], "engine failed");
    }

    #[test]
    fn wake_training_keeps_original_audio_even_when_asr_fails_and_never_clobbers() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("training");
        std::thread::scope(|scope| {
            for result in [
                Ok("Рейдж, команда".to_owned()),
                Err("Transcription returned empty text".to_owned()),
                Err("Speech engine failed".to_owned()),
            ] {
                let root = &root;
                scope.spawn(move || {
                    let staged = Take::wake(root, &[i16::MIN, i16::MAX]).unwrap();
                    assert!(!staged.dir.path().join("meta.json").exists());
                    staged
                        .finish_wake(
                            "/private/base.bin",
                            "ru",
                            &result,
                            json!({"start_sample": 0}),
                        )
                        .unwrap();
                });
            }
        });
        let entries = entries(&root);
        assert_eq!(entries.len(), 3);
        let mut statuses = Vec::new();
        for take in entries {
            assert_eq!(fs::read(take.join("audio.wav")).unwrap(), generated_wav());
            let meta = metadata(&take);
            let status = meta["status"].as_str().unwrap();
            statuses.push(status.to_owned());
            assert_eq!(meta["source"], "wake");
            assert_eq!(meta["model"], "base.bin");
            assert_eq!(meta["language"], "ru");
            assert_eq!(meta["reference_text"], Value::Null);
            assert_eq!(meta["asr_crop"], json!({"start_sample": 0}));
            assert_eq!(
                meta["asr_text"],
                json!((status == "ok").then_some("Рейдж, команда"))
            );
            assert_eq!(
                meta["asr_error"],
                json!((status == "error").then_some("Speech engine failed"))
            );
        }
        statuses.sort();
        assert_eq!(statuses, ["empty", "error", "ok"]);
    }

    #[test]
    fn training_refuses_shared_and_symlink_roots_and_cleans_incomplete_takes() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("shared");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            Take::wake(&root, &[1]).err().unwrap().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(entries(&root).is_empty());
        let link = home.path().join("link");
        std::os::unix::fs::symlink(home.path(), &link).unwrap();
        assert!(Take::wake(&link, &[1]).is_err());
        let root = home.path().join("private");
        drop(Take::wake(&root, &[1]).unwrap());
        assert!(entries(&root).is_empty());
    }
}
