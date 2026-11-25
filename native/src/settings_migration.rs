//! Explicit, offline import before OpenCode starts. No HOME/XDG discovery or directory creation.
use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path},
};

const OLD: &str = "plugin.opencode-voice.settings.json";
const NEW: &str = "plugin.rage.settings.json";
const LIMIT: u64 = 1024 * 1024;
// macOS <sys/fcntl.h>: reject links in *all* path components; never block on a FIFO.
const O_NOFOLLOW_ANY: i32 = 0x2000_0000;
const O_NONBLOCK: i32 = 4;

unsafe extern "C" {
    fn geteuid() -> u32;
    fn fchdir(fd: i32) -> i32;
}

fn open(path: &Path) -> std::io::Result<File> {
    File::options()
        .read(true)
        .custom_flags(O_NOFOLLOW_ANY | O_NONBLOCK)
        .open(path)
}

pub fn run(dir: &Path) -> Result<&'static str, &'static str> {
    if !dir.is_absolute() || dir.components().any(|p| p == Component::ParentDir) {
        return Err("supply the absolute physical path of the OpenCode TUI state directory");
    }
    let folder = match open(dir) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok("no legacy settings"),
        r => {
            r.map_err(|_| "cannot open state directory (use a physical directory, not a symlink)")?
        }
    };
    let meta = folder
        .metadata()
        .map_err(|_| "cannot inspect state directory")?;
    // SAFETY: geteuid takes no arguments; fchdir uses a live descriptor in this single-command process.
    let uid = unsafe { geteuid() };
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o022 != 0 {
        return Err("state directory must be yours and not writable by group or others");
    }
    if unsafe { fchdir(folder.as_raw_fd()) } != 0 {
        return Err("cannot enter state directory");
    }
    // All remaining names are relative to the pinned directory, even if an ancestor is renamed.
    match fs::symlink_metadata(NEW) {
        Ok(_) => return Ok("kept existing Rage settings"),
        Err(e) if e.kind() == ErrorKind::NotFound => (),
        Err(_) => return Err("cannot inspect destination"),
    }
    let source = match open(Path::new(OLD)) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok("no legacy settings"),
        r => r.map_err(|_| "cannot open legacy settings")?,
    };
    let meta = source
        .metadata()
        .map_err(|_| "cannot inspect legacy settings")?;
    if !meta.is_file() || meta.uid() != uid || meta.nlink() != 1 || meta.mode() & 0o022 != 0 {
        return Err("legacy settings must be a regular, user-owned, unshared file");
    }
    let mut bytes = Vec::new();
    source
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read legacy settings")?;
    if bytes.len() as u64 > LIMIT
        || !matches!(
            serde_json::from_slice(&bytes),
            Ok(serde_json::Value::Object(_))
        )
    {
        return Err("expected a legacy JSON settings object of at most 1 MiB");
    }
    let tmp = format!(".rage-settings-{}.tmp", std::process::id());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|_| "cannot create private temporary file")?;
    let result = (|| {
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "cannot save preferences")?;
        // link(2) publishes complete bytes, or EEXIST. It cannot replace another writer's file.
        match fs::hard_link(&tmp, NEW) {
            Ok(()) => Ok("migrated legacy settings"),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok("kept existing Rage settings"),
            Err(_) => Err("cannot publish preferences without overwriting"),
        }
    })();
    fs::remove_file(&tmp).map_err(|_| "cannot remove temporary settings file")?;
    result
}
