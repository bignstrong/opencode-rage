#![cfg(target_os = "macos")]
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::Path,
    process::Command,
    sync::{Arc, Barrier},
    thread,
};

const OLD: &str = "plugin.opencode-voice.settings.json";
const NEW: &str = "plugin.rage.settings.json";
const SOURCE: &[u8] = b"{\"mic\":\"PRIVATE_SENTINEL\",\"future\":[false,1]}\n";

fn call(dir: &Path, success: bool) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_rage-core"))
        .arg("migrate-settings")
        .arg(dir)
        .output()
        .unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert_eq!(out.status.success(), success, "{stdout} {stderr}");
    assert!(!format!("{stdout}{stderr}").contains("PRIVATE_SENTINEL"));
    if success {
        assert!(stderr.is_empty());
        serde_json::from_str(&stdout).unwrap()
    } else {
        assert!(stdout.is_empty());
        stderr
    }
}

#[test]
fn absent_and_existing_do_not_create_or_change_files() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().canonicalize().unwrap();
    let missing = dir.join("missing");
    assert_eq!(call(&missing, true), "no legacy settings");
    assert!(!missing.exists());
    assert_eq!(call(&dir, true), "no legacy settings");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    fs::write(dir.join(NEW), b"existing, even if not JSON").unwrap();
    symlink("does-not-exist", dir.join(OLD)).unwrap();
    assert_eq!(call(&dir, true), "kept existing Rage settings");
    assert_eq!(
        fs::read(dir.join(NEW)).unwrap(),
        b"existing, even if not JSON"
    );
}

#[test]
fn rejects_unsafe_paths_input_and_file_types_without_disclosure() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let dir = base.join("tui");
    fs::create_dir(&dir).unwrap();
    let old = dir.join(OLD);
    let other = base.join("PRIVATE_SENTINEL");
    fs::write(&other, SOURCE).unwrap();
    symlink(&other, &old).unwrap();
    call(&dir, false);
    fs::remove_file(&old).unwrap();
    fs::hard_link(&other, &old).unwrap();
    call(&dir, false);
    fs::remove_file(&old).unwrap();
    for bad in [
        b"invalid PRIVATE_SENTINEL".as_slice(),
        b"[]",
        &vec![b' '; 1_048_577],
    ] {
        fs::write(&old, bad).unwrap();
        call(&dir, false);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }
    fs::write(&old, SOURCE).unwrap();
    symlink(&base, base.join("redirect")).unwrap();
    call(&base.join("redirect/tui"), false);
    call(&dir.join("../tui"), false);
    call(Path::new("."), false);
    fs::set_permissions(&old, fs::Permissions::from_mode(0o666)).unwrap();
    call(&dir, false);
    fs::set_permissions(&old, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
    call(&dir, false);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!dir.join(NEW).exists());
    symlink(&other, dir.join(NEW)).unwrap();
    assert_eq!(call(&dir, true), "kept existing Rage settings");
    assert_eq!(fs::read(&other).unwrap(), SOURCE);
    assert!(dir.join(NEW).is_symlink());
}

#[test]
fn racing_processes_publish_one_private_complete_copy() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().canonicalize().unwrap();
    fs::write(dir.join(OLD), SOURCE).unwrap();
    fs::set_permissions(dir.join(OLD), fs::Permissions::from_mode(0o644)).unwrap();
    let gate = Arc::new(Barrier::new(16));
    let results = thread::scope(|s| {
        let handles: Vec<_> = (0..16)
            .map(|_| {
                s.spawn(|| {
                    gate.wait();
                    let result = call(&dir, true);
                    assert_eq!(fs::read(dir.join(NEW)).unwrap(), SOURCE);
                    result
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        results
            .iter()
            .filter(|r| *r == "migrated legacy settings")
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| *r == "kept existing Rage settings")
            .count(),
        15
    );
    let new = fs::metadata(dir.join(NEW)).unwrap();
    assert_eq!(new.mode() & 0o777, 0o600);
    assert_ne!(new.ino(), fs::metadata(dir.join(OLD)).unwrap().ino());
    assert_eq!(fs::read(dir.join(OLD)).unwrap(), SOURCE);
    assert_eq!(fs::read_dir(dir).unwrap().count(), 2);
}
