//! AVFoundation discovery and capture through the adapter's packaged FFmpeg.
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, Write};
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::{NamedTempFile, TempPath};

#[path = "listen_live.rs"]
pub(crate) mod listen_live;

const TICK: Duration = Duration::from_millis(25);
const SCAN_TIMEOUT: Duration = Duration::from_secs(4);
const START_TIMEOUT: Duration = Duration::from_secs(8);
const STALL_TIMEOUT: Duration = Duration::from_secs(4);
const RESCAN: Duration = Duration::from_secs(2);
const CANCELLED: &str = "Recording canceled";

fn err(e: io::Error) -> String {
    e.to_string()
}

fn ffmpeg() -> Result<OsString, String> {
    env::var_os("RAGE_FFMPEG")
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "RAGE_FFMPEG is not set".into())
}

use crate::mac_inputs::{Device, decode, message, numeric, parse_list};

// Reap the direct child on every exit, including cancellation and failed filesystem I/O.
struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Scan {
    proc: Process,
    text: mpsc::Receiver<Result<String, String>>,
    start: Instant,
}

impl Scan {
    fn start(binary: &OsStr) -> Result<Self, String> {
        let mut proc = Process(
            Command::new(binary)
                .args([
                    "-hide_banner",
                    "-nostdin",
                    "-f",
                    "avfoundation",
                    "-list_devices",
                    "true",
                    "-i",
                    "",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(err)?,
        );
        let stderr = proc.0.stderr.take().ok_or("Missing device list pipe")?;
        let (tx, text) = mpsc::channel();
        thread::spawn(move || {
            let mut list = String::new();
            let limit = 512 * 1024;
            let result = stderr
                .take(limit + 1)
                .read_to_string(&mut list)
                .map_err(err)
                .and_then(|_| {
                    if list.len() as u64 > limit {
                        Err("FFmpeg device list exceeds size limit".into())
                    } else {
                        Ok(list)
                    }
                });
            let _ = tx.send(result);
        });
        Ok(Self {
            proc,
            text,
            start: Instant::now(),
        })
    }

    fn poll(&mut self) -> Result<Option<Vec<Device>>, String> {
        if let Some(status) = self.proc.0.try_wait().map_err(err)? {
            // AVFoundation lists devices and then rejects its deliberately empty input.
            match status.code() {
                Some(0 | 1 | 251) => (),
                Some(code) => return Err(format!("FFmpeg device scan failed (exit {code})")),
                None => return Err("FFmpeg device scan was interrupted".into()),
            }
            match self.text.try_recv() {
                Ok(text) => return Ok(Some(parse_list(&text?)?)),
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("Device list reader failed".into());
                }
                Err(mpsc::TryRecvError::Empty) => (),
            }
        }
        if self.start.elapsed() >= SCAN_TIMEOUT {
            Err("FFmpeg device scan timed out".into())
        } else {
            Ok(None)
        }
    }
}

fn scan(
    binary: &OsStr,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Vec<Device>, String> {
    let mut scan = Scan::start(binary)?;
    loop {
        check()?;
        if let Some(rows) = scan.poll()? {
            return Ok(rows);
        }
        thread::sleep(TICK);
    }
}

pub fn devices() -> Result<Vec<String>, String> {
    let mut choices = Vec::new();
    for device in scan(&ffmpeg()?, || Ok(()))? {
        let value = device.selector();
        if !choices.contains(&value) {
            choices.push(value);
        }
    }
    Ok(choices)
}

fn unavailable(name: &str, reason: &str) -> String {
    format!(
        "Microphone \"{name}\" is unavailable. Choose another microphone in /voice-settings. {reason}"
    )
}

fn select(
    raw: Option<&str>,
    inventory: impl FnOnce() -> Result<Vec<Device>, String>,
) -> Result<(String, Option<Device>), String> {
    let raw = raw.unwrap_or("").trim();
    if matches!(raw, "" | "default" | ":default") {
        return Ok((":default".into(), None));
    }
    let (name, uid) = if let Some(value) = raw.strip_prefix(":uid:") {
        let invalid = || unavailable(raw, "Invalid device identifier.");
        let (uid, name) = value.split_once(':').ok_or_else(invalid)?;
        if uid.is_empty() || name.is_empty() || name.contains(':') {
            return Err(invalid());
        }
        (
            decode(name).ok_or_else(invalid)?,
            Some(decode(uid).ok_or_else(invalid)?),
        )
    } else {
        let name = raw
            .strip_prefix("::")
            .or_else(|| raw.strip_prefix(':'))
            .unwrap_or(raw);
        if name.is_empty() {
            return Err(unavailable(raw, "Empty microphone selector."));
        }
        if !raw.starts_with("::") && numeric(name) {
            return Ok((format!(":{name}"), None));
        }
        (name.to_owned(), None)
    };
    let rows = inventory()?;
    let mut matches = rows.iter().filter(|d| {
        uid.as_ref()
            .map_or_else(|| d.name == name, |key| d.uid.as_ref() == Some(key))
    });
    let device = matches
        .next()
        .ok_or_else(|| unavailable(&name, "No matching audio input."))?;
    if matches.next().is_some() {
        return Err(unavailable(&name, "Multiple matching inputs."));
    }
    // AVFoundation accepts prefixes, splits on colons and interprets numeric names.
    let name = &device.name;
    let numeric_prefix = name
        .trim_start_matches(['+', '-'])
        .starts_with(|c: char| c.is_ascii_digit());
    let index_only = device.uid.is_some()
        || name.contains(':')
        || numeric_prefix
        || name.starts_with("none")
        || name.starts_with("default")
        || rows
            .iter()
            .any(|d| &d.name != name && d.name.starts_with(name));
    Ok((
        format!(":{}", if index_only { &device.index } else { name }),
        Some(device.clone()),
    ))
}

#[derive(Default)]
struct Log {
    opened: Option<String>,
    switched: bool,
    failure: Option<String>,
    last: String,
}

impl Log {
    fn line(&mut self, line: &str) {
        let msg = message(line);
        if let Some(name) = msg
            .strip_prefix("audio device '")
            .and_then(|s| s.strip_suffix("' opened"))
        {
            self.switched |= self.opened.as_deref().is_some_and(|old| old != name);
            self.opened = Some(name.to_owned());
        } else if [
            "Audio device not found",
            "Failed to create AV capture input device",
            "can't add audio input to capture session",
            "Failed to init AV audio output",
            "adding audio output to capture session failed",
        ]
        .iter()
        .any(|s| msg.starts_with(s))
        {
            self.failure = Some(msg.to_owned());
        }
        self.last = msg.chars().take(512).collect();
    }
}

pub(crate) fn wav_header(bytes: u64) -> Result<[u8; 44], String> {
    let size = u32::try_from(bytes)
        .ok()
        .and_then(|n| n.checked_add(36))
        .ok_or("Recording exceeds WAV size limit")?;
    let mut h = *b"RIFF____WAVEfmt \x10\0\0\0\x01\0\x01\0________\x02\0\x10\0data____";
    h[4..8].copy_from_slice(&size.to_le_bytes());
    h[24..28].copy_from_slice(&16_000_u32.to_le_bytes());
    h[28..32].copy_from_slice(&32_000_u32.to_le_bytes());
    h[40..44].copy_from_slice(&(bytes as u32).to_le_bytes());
    Ok(h)
}

// A killed core can leave complete samples after the last header checkpoint.
// Repair only our canonical PCM format, on a private copy of the interrupted take.
pub fn recovered_wav(path: &Path) -> Result<Option<NamedTempFile>, String> {
    let mut source = File::open(path).map_err(err)?;
    let mut old = [0; 44];
    source.read_exact(&mut old).map_err(err)?;
    let actual = source.metadata().map_err(err)?.len().saturating_sub(44);
    let bytes = actual & !1;
    let header = wav_header(bytes)?;
    if bytes == 0 || old[..4] != header[..4] || old[8..40] != header[8..40] {
        return Err("Invalid interrupted PCM recording".into());
    }
    if old == header && bytes == actual {
        return Ok(None);
    }
    let mut copy = tempfile::Builder::new()
        .suffix(".wav")
        .tempfile()
        .map_err(err)?;
    copy.write_all(&header).map_err(err)?;
    if io::copy(&mut source.take(bytes), copy.as_file_mut()).map_err(err)? != bytes {
        return Err("Interrupted PCM recording is incomplete".into());
    }
    Ok(Some(copy))
}

#[derive(Clone, Copy, PartialEq)]
enum Control {
    Stop,
    Cancel,
}

fn read_control(reader: impl BufRead) -> Control {
    for line in reader.lines() {
        match line.as_deref().map(str::trim) {
            Ok("stop") => return Control::Stop,
            Ok("cancel") | Err(_) => break,
            _ => {}
        }
    }
    Control::Cancel
}

pub fn record(
    input: Option<&str>,
    output: &Path,
) -> Result<(bool, Option<Result<String, String>>), String> {
    let binary = ffmpeg().unwrap_or_else(|_| OsString::from("ffmpeg"));
    let (tx, rx) = mpsc::channel();
    // One CLI invocation owns stdin; EOF means the adapter disappeared.
    thread::spawn(move || {
        let _ = tx.send(read_control(io::stdin().lock()));
    });
    let sox = env::var_os("RAGE_SOX").unwrap_or_else(|| OsString::from("sox"));
    let interrupted = record_with_fallback(&binary, &sox, input, output, &rx, || {
        let mut out = io::stdout().lock();
        out.write_all(b"{\"event\":\"ready\"}\n")
            .and_then(|()| out.flush())
            .map_err(err)
    })?;
    Ok((
        interrupted,
        collect_training(output, interrupted, crate::training::directory().as_deref()),
    ))
}

fn collect_training(
    output: &Path,
    interrupted: bool,
    root: Option<&Path>,
) -> Option<Result<String, String>> {
    if interrupted {
        return None;
    }
    Some(crate::training::manual(root?, output).map_err(crate::training::failure))
}

// Track the opened mic, not the system default. Once known, a UID outranks the name.
fn present(rows: &[Device], opened: &str, target: &mut Option<Device>) -> bool {
    let uid = target.as_ref().and_then(|d| d.uid.as_ref());
    let mut hits = rows
        .iter()
        .filter(|d| uid.map_or_else(|| d.name == opened, |key| d.uid.as_ref() == Some(key)));
    if let Some(found) = hits.next()
        && hits.next().is_none()
    {
        *target = Some(found.clone());
        true
    } else {
        false
    }
}

fn record_with_fallback(
    binary: &OsStr,
    sox: &OsStr,
    input: Option<&str>,
    output: &Path,
    control: &mpsc::Receiver<Control>,
    mut ready: impl FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    let mut may_retry = matches!(input.unwrap_or("").trim(), "" | "default" | ":default");
    let first = capture_using(
        binary,
        false,
        input,
        output,
        control,
        &mut ready,
        &mut may_retry,
    );
    match first {
        Err(first) if may_retry && !sox.is_empty() => {
            capture_using(sox, true, None, output, control, ready, &mut false).map_err(|second| {
                format!("Could not start recorder. Tried: {first}; sox default: {second}")
            })
        }
        result => result,
    }
}

#[cfg(test)]
fn capture(
    binary: &OsStr,
    input: Option<&str>,
    output: &Path,
    control: &mpsc::Receiver<Control>,
    ready: impl FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    capture_using(binary, false, input, output, control, ready, &mut false)
}

fn capture_using(
    binary: &OsStr,
    sox: bool,
    input: Option<&str>,
    output: &Path,
    control: &mpsc::Receiver<Control>,
    mut ready: impl FnMut() -> Result<(), String>,
    may_retry: &mut bool,
) -> Result<bool, String> {
    let before_start = || match control.try_recv() {
        Ok(Control::Stop) => Err("Recording stopped before capture started".into()),
        Ok(Control::Cancel) | Err(mpsc::TryRecvError::Disconnected) => Err(CANCELLED.into()),
        Err(mpsc::TryRecvError::Empty) => Ok(()),
    };
    if let Err(error) = before_start() {
        *may_retry = false;
        return Err(error);
    }
    let (source, mut target) = select(input, || scan(binary, before_start))?;
    let expected = target.as_ref().map(|d| d.name.clone());
    let open_error = |detail: String| match expected.as_deref() {
        Some(name) => unavailable(name, &detail),
        None => detail,
    };
    let mut cmd = Command::new(binary);
    if sox {
        cmd.args([
            "-d",
            "-r",
            "16000",
            "-c",
            "1",
            "-b",
            "16",
            "-e",
            "signed-integer",
            "-L",
            "-t",
            "raw",
            "-",
        ]);
    } else {
        cmd.args([
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "debug",
            "-stdin",
            "-f",
            "avfoundation",
        ]);
        if let Some(uid) = target.as_ref().and_then(|d| d.uid.as_ref()) {
            cmd.args(["-audio_device_id", &format!("uid:{uid}")]);
        }
        cmd.args([
            "-i",
            &source,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "s16le",
            "-flush_packets",
            "1",
            "pipe:1",
        ]);
    }
    // FFmpeg writes raw PCM after a reserved header. Even a killed FFmpeg cannot
    // leave an unrepairable muxer trailer; no audio travels over control stdout.
    let dir = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut file = NamedTempFile::new_in(dir).map_err(err)?;
    file.write_all(&wav_header(0)?).map_err(err)?;
    if let Err(error) = before_start() {
        *may_retry = false;
        return Err(error);
    }
    let mut proc = Process(
        cmd.stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .stdout(file.as_file().try_clone().map_err(err)?)
            .spawn()
            .map_err(err)?,
    );
    let stderr = proc.0.stderr.take().ok_or("Missing FFmpeg stderr")?;
    let log = Arc::new(Mutex::new(Log::default()));
    let shared = Arc::clone(&log);
    let mut logs = Some(thread::spawn(move || {
        for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
            shared.lock().unwrap().line(&String::from_utf8_lossy(&line));
        }
    }));
    let start = Instant::now();
    let mut progress = start;
    let mut last_bytes = 0;
    let mut announced = false;
    let mut next_scan = start;
    let mut scanning = None::<Scan>;
    let mut stop_time = None::<Instant>;
    let mut interrupted = false;
    let mut manual_stop = false;
    loop {
        let exit = proc.0.try_wait().map_err(err)?;
        if exit.is_some()
            && let Some(t) = logs.take()
        {
            t.join().map_err(|_| "FFmpeg log reader failed")?;
        }
        let state = log.lock().map_err(|_| "FFmpeg log reader failed")?;
        let opened = state.opened.clone();
        if opened.is_some() {
            *may_retry = false;
        }
        if state.switched
            || expected
                .as_ref()
                .zip(opened.as_ref())
                .is_some_and(|(wanted, got)| wanted != got)
        {
            return Err(unavailable(
                input.unwrap_or("default"),
                "FFmpeg opened a different microphone.",
            ));
        }
        let verified = expected.is_none() || opened.is_some();
        let failure = state.failure.clone();
        let last = state.last.clone();
        drop(state);
        let mut stop = false;
        if !manual_stop {
            match control.try_recv() {
                Ok(Control::Cancel) | Err(mpsc::TryRecvError::Disconnected) => {
                    *may_retry = false;
                    return Err(CANCELLED.into());
                }
                Ok(Control::Stop) => {
                    *may_retry = false;
                    manual_stop = true;
                    stop = true;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        let bytes = file
            .as_file()
            .metadata()
            .map_err(err)?
            .len()
            .saturating_sub(44);
        if bytes != last_bytes {
            *may_retry = false;
            progress = Instant::now();
            last_bytes = bytes;
            // pwrite does not move FFmpeg's shared write offset.
            file.as_file()
                .write_all_at(&wav_header(bytes & !1)?, 0)
                .map_err(err)?;
        }
        if exit.is_none()
            && stop_time.is_none()
            && let Some(name) = &opened
        {
            if !stop && scanning.is_none() && Instant::now() >= next_scan {
                scanning = Scan::start(binary).ok();
                next_scan = Instant::now() + RESCAN;
            }
            if let Some(scan) = scanning.as_mut() {
                match scan.poll() {
                    Ok(Some(rows)) => {
                        if !announced
                            && target.is_none()
                            && rows.iter().filter(|d| &d.name == name).count() > 1
                        {
                            return Err(unavailable(
                                name,
                                "Cannot identify which same-name input opened.",
                            ));
                        }
                        interrupted |= !present(&rows, name, &mut target);
                        scanning = None;
                    }
                    Err(_) => scanning = None, // A failed scan is not evidence of a disconnect.
                    Ok(None) => {}
                }
            }
        }
        // Bind the default/index capture's UID before acknowledging its known name.
        let binding = target.is_none() && scanning.is_some() && exit.is_none() && !stop;
        if !announced && verified && !binding && bytes >= 2 {
            // Expose only verified audio. Drop still unlinks on cancel/error;
            // SIGKILL leaves the last checkpoint and any subsequent PCM at output.
            let handle = file.persist_noclobber(output).map_err(|e| err(e.error))?;
            file = NamedTempFile::from_parts(handle, TempPath::try_from_path(output).map_err(err)?);
            ready()?;
            announced = true;
        }
        if let Some(status) = exit {
            interrupted |= stop_time.is_none() || !(normal_stop(status) || sox && manual_stop);
            if !announced {
                return Err(open_error(failure.unwrap_or_else(|| {
                    format!("FFmpeg stopped before verified audio: {last}")
                })));
            }
            break;
        }
        if let Some(t) = stop_time {
            if t.elapsed() >= Duration::from_secs(1) {
                proc.0.kill().map_err(err)?;
                proc.0.wait().map_err(err)?;
            }
        } else {
            if let Some(detail) = failure {
                if !announced {
                    return Err(open_error(detail));
                }
                interrupted = true;
            }
            if !announced && start.elapsed() >= START_TIMEOUT {
                return Err(open_error(format!(
                    "Timed out waiting for verified audio: {last}"
                )));
            }
            interrupted |= announced && progress.elapsed() >= STALL_TIMEOUT;
            if stop || interrupted {
                stop_time = Some(Instant::now());
                drop(scanning.take());
                if sox {
                    // Raw PCM has no trailer. The parent finalizes the WAV from complete samples.
                    let _ = proc.0.kill();
                } else if let Some(mut stdin) = proc.0.stdin.take() {
                    let _ = stdin.write_all(b"q\n");
                }
            }
        }
        thread::sleep(TICK);
    }
    drop(scanning);
    let complete = last_bytes & !1;
    file.as_file().set_len(44 + complete).map_err(err)?;
    file.rewind().map_err(err)?;
    file.write_all(&wav_header(complete)?).map_err(err)?;
    file.keep()
        .map_err(|e| format!("Could not save recording: {}", e.error))?;
    // Publish verified PCM before the final scan: even a slow inventory must not lose the take.
    let opened = log
        .lock()
        .map_err(|_| "FFmpeg log reader failed")?
        .opened
        .clone();
    if !interrupted
        && let Some(name) = opened
        && let Ok(rows) = scan(binary, || Ok(()))
    {
        interrupted = !present(&rows, &name, &mut target);
    }
    Ok(interrupted)
}

fn normal_stop(status: ExitStatus) -> bool {
    status.success() || status.code() == Some(255)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
    use tempfile::TempDir;

    const LIST: &str = "[AVFoundation indev @ 0x1] AVFoundation video devices:\n\
        [AVFoundation indev @ 0x1] [0] Camera\n\
        [AVFoundation indev @ 0x1] AVFoundation audio devices:\n\
        [AVFoundation indev @ 0x1] [0] Mac Mic\n\
        [AVFoundation indev @ 0x1] [1] Jo’s iPhone  [uid:a:b] [serial:1]\n";
    const OPEN: &str = "echo \"[avfoundation @ 0x1] audio device 'Jo’s iPhone' opened\" >&2\n";
    const SAMPLE: &str = "printf '\\001\\002\\003\\004\\005'\n";
    const PIN: &str = ":uid:a%3Ab:Jo%E2%80%99s%20iPhone";

    #[test]
    fn selectors_round_trip_and_do_not_bind_same_name_replacement() {
        let mut rows = parse_list(LIST).unwrap();
        assert_eq!(
            rows.iter().map(Device::selector).collect::<Vec<_>>(),
            [":Mac Mic", PIN]
        );
        let mut replacement = rows[1].clone();
        replacement.uid = Some("other".into());
        rows.push(replacement);
        assert!(select(Some(":Jo’s iPhone"), || Ok(rows.clone())).is_err());
        rows.reverse();
        let (source, mut pin) = select(Some(PIN), || Ok(rows.clone())).unwrap();
        assert_eq!(source, ":1");
        assert!(present(&rows, "Jo’s iPhone", &mut pin));
        rows.retain(|d| d.uid.as_deref() != Some("a:b"));
        assert!(!present(&rows, "Jo’s iPhone", &mut pin));
        assert!(select(Some(PIN), || Ok(rows)).is_err());
    }

    #[test]
    fn legacy_indices_default_and_collision_escapes() {
        for (value, source) in [
            (None, ":default"),
            (Some(""), ":default"),
            (Some("default"), ":default"),
            (Some(":default"), ":default"),
            (Some(":2"), ":2"),
            (Some("2"), ":2"),
        ] {
            assert_eq!(
                select(value, || panic!("unexpected scan")).unwrap(),
                (source.into(), None)
            );
        }
        let rows = parse_list(
            "AVFoundation audio devices:\n[4] 2\n[3] default\n[8] :Studio\n[5] Mic\n[6] Mic 2\n",
        )
        .unwrap();
        for (i, wire, source) in [
            (0, "::2", ":4"),
            (1, "::default", ":3"),
            (2, ":::Studio", ":8"),
            (3, ":Mic", ":5"),
            (4, ":Mic 2", ":Mic 2"),
        ] {
            assert_eq!(rows[i].selector(), wire);
            assert_eq!(select(Some(wire), || Ok(rows.clone())).unwrap().0, source);
        }
        for bad in [":", "::", ":uid::name", ":uid:%ZZ:name", ":uid:a:b:c"] {
            assert!(select(Some(bad), || panic!("invalid selector reached scan")).is_err());
        }
    }

    #[test]
    fn empty_inventory_is_not_a_failed_inventory() {
        assert!(
            parse_list("AVFoundation audio devices:")
                .unwrap()
                .is_empty()
        );
        for text in [
            "AVFoundation video devices:",
            "AVFoundation audio devices:\n[0]",
            "AVFoundation audio devices:\n[1] USB  [uid:a",
        ] {
            assert!(parse_list(text).is_err());
        }
    }

    // Nothing here resolves or runs a real FFmpeg, even on a Mac with mic permission.
    fn fake(body: &str) -> (TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("fake ffmpeg");
        fs::write(dir.path().join("list"), LIST).unwrap();
        fs::write(&binary, format!("#!/bin/sh\ncd \"${{0%/*}}\" || exit 90\ncase \" $* \" in *' -list_devices '*) cat list >&2; if [ -f scan-status ]; then exit \"$(cat scan-status)\"; fi; exit 1;; esac\nprintf '%s\\n' \"$@\" > args\n{body}\n")).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let wav = dir.path().join("take.wav");
        (dir, binary, wav)
    }

    fn verify_wav(path: &Path) {
        let bytes = fs::read(path).unwrap();
        assert_eq!(bytes.len(), 48);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(bytes[4..8], 40_u32.to_le_bytes());
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(bytes[22..24], 1_u16.to_le_bytes());
        assert_eq!(bytes[24..28], 16_000_u32.to_le_bytes());
        assert_eq!(bytes[34..36], 16_u16.to_le_bytes());
        assert_eq!(bytes[40..44], 4_u32.to_le_bytes());
        assert_eq!(&bytes[44..], &[1, 2, 3, 4]);
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
    }

    #[test]
    fn sox_is_only_a_pre_open_fallback_for_the_system_input() {
        let (_dir, sox, path) = fake(&format!("{SAMPLE}read -r cmd"));
        let (tx, rx) = mpsc::channel();
        assert_eq!(
            record_with_fallback(
                OsStr::new("/missing/rage/ffmpeg"),
                sox.as_os_str(),
                None,
                &path,
                &rx,
                || {
                    tx.send(Control::Stop).unwrap();
                    Ok(())
                }
            ),
            Ok(false)
        );
        verify_wav(&path);
        let (_dir, ff, output) = fake(&format!("{OPEN}exit 1"));
        for input in [None, Some(PIN)] {
            assert!(
                record_with_fallback(
                    ff.as_os_str(),
                    sox.as_os_str(),
                    input,
                    &output,
                    &rx,
                    || panic!("opened device must never be replaced")
                )
                .is_err()
            );
        }
    }

    #[test]
    fn ready_then_stop_finalizes_private_wav_and_honors_uid_argv() {
        let (dir, bin, path) = fake(&format!("{OPEN}{SAMPLE}read -r cmd && [ \"$cmd\" = q ]"));
        let (tx, rx) = mpsc::channel();
        let mut events = 0;
        assert_eq!(
            capture(bin.as_os_str(), Some(PIN), &path, &rx, || {
                events += 1;
                assert!(path.is_file());
                tx.send(Control::Stop).unwrap();
                Ok(())
            }),
            Ok(false)
        );
        assert_eq!(events, 1);
        verify_wav(&path);
        let args = fs::read_to_string(dir.path().join("args")).unwrap();
        assert!(args.contains("-audio_device_id\nuid:a:b\n-i\n:1\n"));
    }

    #[test]
    fn manual_training_is_opt_in_and_skips_interrupted_pcm() {
        let (dir, bin, path) = fake(&format!("{OPEN}{SAMPLE}read -r cmd"));
        let (tx, rx) = mpsc::channel();
        let interrupted = capture(bin.as_os_str(), Some(PIN), &path, &rx, || {
            tx.send(Control::Stop).unwrap();
            Ok(())
        })
        .unwrap();
        assert!(!interrupted);
        let root = dir.path().join("training");
        assert_eq!(collect_training(&path, interrupted, None), None);
        assert_eq!(collect_training(&path, true, Some(&root)), None);
        assert!(!root.exists());
        let id = collect_training(&path, interrupted, Some(&root))
            .unwrap()
            .unwrap();
        let take = root.join(id);
        verify_wav(&take.join("audio.wav"));
        let error = collect_training(&path, interrupted, Some(&path))
            .unwrap()
            .unwrap_err();
        assert!(error.starts_with("RAGE_TRAINING_DIR:"));
        verify_wav(&path);
    }

    #[test]
    fn early_eof_recovers_pcm_even_before_first_poll() {
        for (pin, log, status) in [(Some(PIN), OPEN, 1), (Some(PIN), OPEN, 0), (None, "", 0)] {
            let (_dir, bin, path) = fake(&format!("{log}{SAMPLE}exit {status}"));
            let (_tx, rx) = mpsc::channel();
            let mut events = 0;
            assert_eq!(
                capture(bin.as_os_str(), pin, &path, &rx, || {
                    events += 1;
                    Ok(())
                }),
                Ok(true)
            );
            assert_eq!(events, 1);
            verify_wav(&path);
        }
    }

    #[test]
    fn only_a_completed_empty_scan_at_stop_means_disconnect() {
        for (code, disconnected) in [(0, true), (1, true), (251, true), (2, false)] {
            let (dir, bin, path) = fake(&format!("{OPEN}{SAMPLE}read -r cmd"));
            let (tx, rx) = mpsc::channel();
            let result = capture(bin.as_os_str(), Some(PIN), &path, &rx, || {
                fs::write(dir.path().join("scan-status"), code.to_string()).unwrap();
                fs::write(dir.path().join("list"), "AVFoundation audio devices:\n").unwrap();
                tx.send(Control::Stop).unwrap();
                Ok(())
            });
            assert_eq!(result, Ok(disconnected), "inventory exit {code}");
            verify_wav(&path);
        }
    }

    #[test]
    fn pinned_open_failure_identifies_the_selected_mic_before_ready() {
        for end in ["exit 1", "read -r cmd"] {
            let (_dir, bin, path) = fake(&format!(
                "echo '[avfoundation @ 0x1] Audio device not found' >&2\n{end}"
            ));
            let (_tx, rx) = mpsc::channel();
            assert_eq!(
                capture(bin.as_os_str(), Some(PIN), &path, &rx, || panic!(
                    "spurious ready"
                )),
                Err(unavailable("Jo’s iPhone", "Audio device not found"))
            );
            assert!(!path.exists());
        }
    }

    #[test]
    fn stop_rescans_after_disconnect_while_ffmpeg_is_alive() {
        let (dir, bin, path) = fake(&format!("{OPEN}{SAMPLE}read -r cmd"));
        let (tx, rx) = mpsc::channel();
        assert_eq!(
            capture(bin.as_os_str(), Some(PIN), &path, &rx, || {
                fs::write(
                    dir.path().join("list"),
                    LIST.replace("uid:a:b", "uid:replacement"),
                )
                .unwrap();
                tx.send(Control::Stop).unwrap();
                Ok(())
            }),
            Ok(true)
        );
        verify_wav(&path);
    }

    #[test]
    fn unplug_ends_live_take_without_stop_and_never_switches() {
        let (dir, bin, path) = fake(&format!("{OPEN}{SAMPLE}read -r cmd"));
        let (_tx, rx) = mpsc::channel();
        assert_eq!(
            capture(bin.as_os_str(), Some(PIN), &path, &rx, || {
                fs::write(
                    dir.path().join("list"),
                    "AVFoundation audio devices:\n[0] Mac Mic\n",
                )
                .unwrap();
                Ok(())
            }),
            Ok(true)
        );
        verify_wav(&path);
    }

    #[test]
    fn default_binds_opened_uid_before_ready_even_if_a_replacement_has_its_name() {
        let (dir, bin, path) = fake(&format!("{OPEN}{SAMPLE}read -r cmd"));
        let (tx, rx) = mpsc::channel();
        assert_eq!(
            capture(bin.as_os_str(), None, &path, &rx, || {
                fs::write(dir.path().join("list"), LIST.replace("uid:a:b", "uid:c")).unwrap();
                tx.send(Control::Stop).unwrap();
                Ok(())
            }),
            Ok(true)
        );
        verify_wav(&path);
    }

    #[test]
    fn same_name_default_is_rejected_and_failed_rescan_does_not_imply_disconnect() {
        let (dir, bin, path) = fake(&format!("{OPEN}{SAMPLE}read -r cmd"));
        let (tx, rx) = mpsc::channel();
        fs::write(
            dir.path().join("list"),
            format!("{LIST}[3] Jo’s iPhone  [uid:c]\n"),
        )
        .unwrap();
        assert!(
            capture(bin.as_os_str(), None, &path, &rx, || panic!(
                "ambiguous default"
            ))
            .is_err()
        );
        assert!(!path.exists());
        fs::write(dir.path().join("list"), LIST).unwrap();
        assert_eq!(
            capture(bin.as_os_str(), Some(PIN), &path, &rx, || {
                fs::write(dir.path().join("list"), "device enumeration failed\n").unwrap();
                tx.send(Control::Stop).unwrap();
                Ok(())
            }),
            Ok(false)
        );
        verify_wav(&path);
    }

    #[test]
    fn unverified_or_empty_take_is_never_published() {
        for body in [
            format!("{}{SAMPLE}", OPEN.replace("Jo’s iPhone", "Mac Mic")),
            SAMPLE.into(),
            OPEN.into(),
        ] {
            let (_dir, bin, path) = fake(&body);
            let (_tx, rx) = mpsc::channel();
            assert!(
                capture(bin.as_os_str(), Some(PIN), &path, &rx, || panic!(
                    "spurious ready"
                ))
                .is_err()
            );
            assert!(!path.exists());
        }
    }

    #[test]
    fn cancel_and_parent_eof_discard_wav() {
        assert!(matches!(read_control(&b""[..]), Control::Cancel));
        assert!(matches!(read_control(&b"cancel\n"[..]), Control::Cancel));
        assert!(matches!(read_control(&b"stop\n"[..]), Control::Stop));
        let (_dir, bin, path) = fake(&format!("{OPEN}{SAMPLE}read -r cmd"));
        let (tx, rx) = mpsc::channel();
        assert_eq!(
            capture(bin.as_os_str(), None, &path, &rx, || {
                tx.send(Control::Cancel).unwrap();
                Ok(())
            }),
            Err(CANCELLED.into())
        );
        assert!(!path.exists());
    }
}
