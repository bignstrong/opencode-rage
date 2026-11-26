//! Both inputs produce the same ten-millisecond frames. Only completed turns reach ASR.
//! Protocol: waiting, heard(id), optional text(id), waiting. IDs are per-process.
//! Coarse level events carry no turn ID and are emitted only while waiting.
//! ASR runs once after 800 ms of quiet or 20 s of capture; new hits are ignored until
//! rearm. A wake with no command gets 2 s of quiet to start one. WAV EOF drops an
//! unfinished turn. Control EOF, stop, cancel, and parent loss discard pending output.
use crate::{audio::listen_live::Live, send, speech, training, wake_detector::Detector};
use serde_json::json;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

type Frame = [i16; 160];
const FRAME_TIME: Duration = Duration::from_millis(10);
const PRE_ROLL: usize = 10;
const ONSET_PAD: usize = 3200;
const END_SILENCE: usize = 80;
const MAX_TURN: usize = 2000;
const STOPPED: &str = "Wake listener stopped";

pub(crate) fn samples(bytes: &[u8; 320]) -> Frame {
    std::array::from_fn(|i| i16::from_le_bytes([bytes[2 * i], bytes[2 * i + 1]]))
}

static SIGNAL: AtomicBool = AtomicBool::new(false);
extern "C" fn stop_signal(_: libc::c_int) {
    SIGNAL.store(true, Ordering::Relaxed);
}

struct Control {
    parent: libc::pid_t,
    line: Vec<u8>,
}
impl Control {
    fn new() -> Self {
        // SAFETY: the handler only sets a lock-free flag; getppid has no preconditions.
        unsafe {
            for sig in [libc::SIGINT, libc::SIGHUP, libc::SIGTERM] {
                libc::signal(sig, stop_signal as *const () as libc::sighandler_t);
            }
            Self {
                parent: libc::getppid(),
                line: Vec::new(),
            }
        }
    }
    fn check(&mut self) -> Result<(), String> {
        // SAFETY: getppid has no preconditions. stdin is the owned control pipe.
        if SIGNAL.load(Ordering::Relaxed)
            || self.parent == 1
            || self.parent != unsafe { libc::getppid() }
        {
            return Err(STOPPED.into());
        }
        let mut fd = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one initialized pollfd, no wait.
        if unsafe { libc::poll(&mut fd, 1, 0) } < 0 || fd.revents & !libc::POLLIN != 0 {
            return Err(STOPPED.into());
        }
        if fd.revents != 0 {
            let mut bytes = [0u8; 128];
            // SAFETY: readable fd, valid writable slice; no other reader consumes stdin.
            let n = unsafe { libc::read(0, bytes.as_mut_ptr().cast(), bytes.len()) };
            if n <= 0 {
                return Err(STOPPED.into());
            }
            for &b in &bytes[..n as usize] {
                if b == b'\n' {
                    if matches!(self.line.trim_ascii(), b"stop" | b"cancel") {
                        return Err(STOPPED.into());
                    }
                    self.line.clear();
                } else if self.line.len() == 128 {
                    return Err("Invalid wake listener control line".into());
                } else {
                    self.line.push(b);
                }
            }
        }
        Ok(())
    }
}

struct Replay {
    file: BufReader<File>,
    remaining: u64,
    due: Instant,
}
impl Replay {
    fn open(path: &Path) -> io::Result<Self> {
        let invalid = || {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Expected a 16 kHz mono 16-bit PCM RIFF/WAVE file",
            )
        };
        let mut f = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)?;
        let meta = f.metadata()?;
        if !meta.is_file() {
            return Err(invalid());
        }
        let mut riff = [0; 12];
        f.read_exact(&mut riff)?;
        let size = |b: &[u8]| u32::from_le_bytes(b.try_into().expect("four size bytes")) as u64;
        let end = 8 + size(&riff[4..8]);
        if &riff[..4] != b"RIFF" || &riff[8..] != b"WAVE" || end > meta.len() {
            return Err(invalid());
        }
        let mut pos = 12;
        let mut format = false;
        while pos + 8 <= end {
            let mut chunk = [0; 8];
            f.read_exact(&mut chunk)?;
            let n = size(&chunk[4..]);
            pos += 8 + n + n % 2;
            if pos > end {
                return Err(invalid());
            }
            match &chunk[..4] {
                b"fmt " => {
                    let mut fmt = [0; 16];
                    if n < 16 {
                        return Err(invalid());
                    }
                    f.read_exact(&mut fmt)?;
                    if fmt[..] != crate::audio::wav_header(0).expect("zero-size header")[20..36] {
                        return Err(invalid());
                    }
                    format = true;
                }
                b"data" if format && n % 2 == 0 => {
                    return Ok(Self {
                        file: BufReader::new(f),
                        remaining: n,
                        due: Instant::now(),
                    });
                }
                b"data" => return Err(invalid()),
                _ => {}
            }
            f.seek(SeekFrom::Start(pos))?;
        }
        Err(invalid())
    }
    fn poll(&mut self) -> Result<Poll, String> {
        if self.remaining < 320 {
            return Ok(Poll::End);
        }
        if Instant::now() < self.due {
            return Ok(Poll::Pending);
        }
        let mut bytes = [0; 320];
        self.file
            .read_exact(&mut bytes)
            .map_err(|e| e.to_string())?;
        self.remaining -= 320;
        self.due += FRAME_TIME;
        Ok(Poll::Frame(samples(&bytes)))
    }
}

enum Source {
    Live(Box<Live>),
    Wav(Replay),
}
#[allow(clippy::large_enum_variant)] // Frame lives on the stack rather than allocating at 100 Hz.
enum Poll {
    Frame(Frame),
    Pending,
    End,
}
impl Source {
    fn poll(&mut self) -> Result<Poll, String> {
        match self {
            Self::Live(live) => Ok(live.poll()?.map_or(Poll::Pending, Poll::Frame)),
            Self::Wav(wav) => wav.poll(),
        }
    }
}

struct Turn {
    pcm: Vec<i16>,
    frames: usize,
    quiet: usize,
    crop: Option<usize>,
}

fn energy(frame: &Frame) -> i64 {
    frame.iter().map(|&s| i64::from(s).pow(2)).sum()
}
const AUDIBLE: i64 = 128 * 128 * 160;

const METER_WINDOW: Duration = Duration::from_millis(250);

#[derive(Default)]
struct Meter {
    since: Option<Instant>,
    peak: i64,
    previous: Option<u8>,
}

impl Meter {
    fn observe(&mut self, frame: &Frame, now: Instant) -> Option<u8> {
        self.peak = self.peak.max(energy(frame));
        if now.duration_since(*self.since.get_or_insert(now)) < METER_WINDOW {
            return None;
        }
        self.since = Some(now);
        let level = match std::mem::take(&mut self.peak) {
            peak if peak >= 4096 * 4096 * 160 => 3,
            peak if peak >= 1024 * 1024 * 160 => 2,
            peak if peak >= AUDIBLE => 1,
            _ => 0,
        };
        (self.previous.replace(level) != Some(level)).then_some(level)
    }
}

fn crossings(frame: &Frame) -> usize {
    frame
        .windows(2)
        .filter(|p| (p[0] < 0) != (p[1] < 0))
        .count()
}

fn frication(frame: &Frame) -> bool {
    crossings(frame) >= 45 && energy(frame) >= 180 * 180 * 160
}

// Only a burst already established when the detector fired can belong to the wake.
fn wake_end(frames: &[Frame], hit: usize) -> Option<usize> {
    if hit < 2 || !frames[hit - 2..hit].iter().all(frication) {
        return None;
    }
    let tail = frames[hit..].iter().take(14).position(|f| !frication(f))?;
    Some(hit + tail)
}
impl Turn {
    fn start(ring: &mut VecDeque<Frame>) -> Self {
        // Keep the wake tail and immediate consonants. Silence gives ASR onset context
        // without feeding speech from before the address into its transcript.
        let mut pcm = vec![0; ONSET_PAD];
        pcm.extend(ring.drain(..).flatten());
        Self {
            pcm,
            frames: 0,
            quiet: 0,
            crop: None,
        }
    }
    fn push(&mut self, frame: &Frame) -> bool {
        self.pcm.extend_from_slice(frame);
        self.frames += 1;
        self.quiet = if energy(frame) < AUDIBLE {
            self.quiet + 1
        } else {
            0
        };
        if self.quiet == END_SILENCE || self.frames == MAX_TURN {
            self.crop = self.command_start();
        }
        self.has_command() || self.quiet >= 200 || self.frames >= MAX_TURN
    }
    fn has_command(&self) -> bool {
        self.crop.is_some()
    }

    fn command_start(&self) -> Option<usize> {
        let frames = self.pcm[ONSET_PAD..].as_chunks::<160>().0;
        let hit = frames.len() - self.frames;
        let boundary = wake_end(frames, hit);
        let start = boundary.unwrap_or(hit);
        let crop = boundary.map_or(0, |i| i.saturating_sub(1) * 160);
        let mut audible = 0;
        let mut voiced = 0;
        let mut quiet = 0;
        let mut after_pause = false;
        for f in &frames[start..] {
            if energy(f) < AUDIBLE {
                quiet += 1;
                voiced = 0;
                continue;
            }
            // A new burst after silence, or a pitched vowel after the affricate,
            // can establish a command within the first few frames after the hit.
            if quiet >= 2 {
                after_pause = true;
            }
            if after_pause && quiet == 0 {
                return Some(crop);
            }
            quiet = 0;
            audible += 1;
            voiced = if (1..45).contains(&crossings(f)) {
                voiced + 1
            } else {
                0
            };
            if voiced >= 2 || audible >= 19 {
                return Some(crop);
            }
        }
        None
    }

    fn command_audio(&mut self) -> &[i16] {
        let crop = self.crop.expect("only submit confirmed commands");
        let pcm = &mut self.pcm[crop..];
        pcm[..ONSET_PAD].fill(0);
        pcm
    }

    fn training_audio(&self) -> &[i16] {
        &self.pcm[self.pcm.len() - self.frames * 160..]
    }

    fn training_crop(&self) -> serde_json::Value {
        let crop = self.crop.expect("only submit confirmed commands");
        let pre_roll = self.pcm.len() - ONSET_PAD - self.frames * 160;
        json!({
            "start_sample": crop as isize - pre_roll as isize,
            "sample_count": self.pcm.len() - crop - ONSET_PAD,
            "leading_silence_samples": ONSET_PAD,
        })
    }
}

fn strip_name(text: &str) -> &str {
    let start = text.trim_start_matches(|c: char| c.is_whitespace() || "«\"“".contains(c));
    let end = start
        .find(|c: char| !c.is_alphanumeric() && c != '_')
        .unwrap_or(start.len());
    if matches!(
        start[..end].to_lowercase().as_str(),
        "рейдж" | "рэйдж" | "рейж" | "rage"
    ) {
        let rest = start[end..]
            .trim_start_matches([',', '.', '!', '?', ':', ';', '»', '"', '”'])
            .trim_start();
        rest.strip_prefix(['–', '—', '-'])
            .filter(|s| s.starts_with(char::is_whitespace))
            .map_or(rest, str::trim_start)
    } else {
        text
    }
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    match session(args, &mut Control::new()) {
        Err(e) if e == STOPPED => Ok(()),
        result => result,
    }
}

fn session(args: &[String], control: &mut Control) -> Result<(), String> {
    let [flag, location, lang, model] = args else {
        return Err("usage: rage-core listen (--wav PATH | --input DEVICE) LANG MODEL".into());
    };
    control.check()?;
    let mut detector = match std::env::var_os("RAGE_WAKE_PROFILE") {
        Some(path) => Detector::from_wav_dir(Path::new(&path))?,
        None => Detector::new(),
    };
    let mut source = match flag.as_str() {
        "--wav" => Source::Wav(Replay::open(Path::new(location)).map_err(|e| e.to_string())?),
        "--input" => Source::Live(Box::new(Live::open(location, || control.check())?)),
        _ => return Err("Expected --input DEVICE or --wav PATH".into()),
    };
    let training_dir = if matches!(&source, Source::Live(_)) {
        training::collection_directory()
    } else {
        None
    };
    let mut ring = VecDeque::<Frame>::with_capacity(PRE_ROLL);
    let mut turn: Option<Turn> = None;
    let mut id = 0u64;
    let mut announced = false;
    let mut meter = Meter::default();
    loop {
        control.check()?;
        let frame = match source.poll()? {
            Poll::Frame(frame) => frame,
            Poll::End => return Ok(()), // An unterminated take is never submitted.
            Poll::Pending => {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
        };
        if !announced {
            send(json!({"event":"waiting"}))?;
            announced = true;
        }
        if let Some(take) = &mut turn {
            if !take.push(&frame) {
                continue;
            }
            let mut completed = turn.take().expect("completed turn");
            if !completed.has_command() {
                detector.reset();
                send(json!({"event":"waiting"}))?;
                continue;
            }
            // Stage the unmodified post-hit samples before command_audio masks the ASR prefix.
            control.check()?;
            let staged = training_dir
                .as_deref()
                .map(|root| training::Take::wake(root, completed.training_audio()))
                .transpose();
            let deadline = Instant::now() + Duration::from_secs(180);
            let mut pump = || -> Result<(), String> {
                control.check()?;
                if Instant::now() >= deadline {
                    return Err("Wake transcription timed out".into());
                }
                // Drain the same stream while busy. Never replay stale audio on rearm.
                for _ in 0..100 {
                    if !matches!(source.poll()?, Poll::Frame(_)) {
                        break;
                    }
                }
                Ok(())
            };
            let result = speech::transcribe_turn(completed.command_audio(), model, lang, &mut pump);
            let training_error = staged
                .and_then(|take| match take {
                    Some(take) => take
                        .finish_wake(model, lang, &result, completed.training_crop())
                        .map(drop),
                    None => Ok(()),
                })
                .err()
                .map(training::failure);
            if let Some(error) = training_error {
                eprintln!("{error}");
                send(json!({"event":"training_error","message":error}))?;
            }
            let text = match result {
                Ok(text) => text,
                Err(e) if e == "Transcription returned empty text" => String::new(),
                Err(e) => return Err(e),
            };
            pump()?;
            if let Source::Live(live) = &mut source {
                live.verify_before_delivery(|| control.check())?;
            }
            let command = strip_name(&text);
            control.check()?;
            if !command.is_empty() {
                send(json!({"event":"text","id":id,"text":command}))?;
            }
            detector.reset();
            send(json!({"event":"waiting"}))?;
        } else {
            if ring.len() == PRE_ROLL {
                ring.pop_front();
            }
            ring.push_back(frame);
            if detector.push(&frame) {
                id += 1;
                control.check()?;
                send(json!({"event":"heard","id":id}))?;
                turn = Some(Turn::start(&mut ring));
                meter = Meter::default();
            } else if let Some(level) = meter.observe(&frame, Instant::now()) {
                send(json!({"event":"level","level":level}))?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meter_reports_coarse_window_peaks_then_releases_to_silence() {
        let mut meter = Meter::default();
        let start = Instant::now();
        let mut sample =
            |ms, amplitude| meter.observe(&[amplitude; 160], start + Duration::from_millis(ms));
        assert_eq!(sample(0, 0), None);
        assert_eq!(sample(249, i16::MIN), None);
        assert_eq!(sample(250, 0), Some(3));
        assert_eq!(sample(500, 1024), Some(2));
        assert_eq!(sample(750, 128), Some(1));
        assert_eq!(sample(1000, 127), Some(0));
        assert_eq!(sample(1250, 0), None);
    }

    // A short pitched vowel and unvoiced frication occupy different acoustic bands.
    fn vowel() -> Frame {
        std::array::from_fn(|i| (3000. * (i as f32 * std::f32::consts::TAU / 80.).sin()) as i16)
    }
    fn hiss() -> Frame {
        std::array::from_fn(|i| if i % 4 < 2 { -1400 } else { 1400 })
    }
    fn finish_after_speech(turn: &mut Turn) {
        for _ in 1..END_SILENCE {
            assert!(!turn.push(&[0; 160]));
        }
        assert!(
            turn.push(&[0; 160]),
            "brief command should end after normal silence"
        );
        assert!(turn.has_command());
    }

    #[test]
    fn brief_vowel_after_the_wake_tail_reaches_asr() {
        let mut ring = VecDeque::from([hiss(); PRE_ROLL]);
        let mut turn = Turn::start(&mut ring);
        for frame in [hiss(), hiss(), vowel(), vowel(), vowel()] {
            turn.push(&frame);
        }
        finish_after_speech(&mut turn);
        let audio = &turn.command_audio()[ONSET_PAD..];
        assert_eq!(&audio[..160], hiss()); // 10 ms overlap before the transition
        assert_eq!(&audio[160..320], vowel());
    }

    #[test]
    fn post_hit_command_fricative_keeps_the_entire_pre_roll() {
        let before = [21; 160];
        let mut ring = VecDeque::from([before; PRE_ROLL]);
        let mut turn = Turn::start(&mut ring);
        for frame in [hiss(), hiss(), hiss(), hiss(), vowel(), vowel()] {
            turn.push(&frame);
        }
        finish_after_speech(&mut turn);
        let audio = &turn.command_audio()[ONSET_PAD..];
        assert_eq!(&audio[..PRE_ROLL * 160], [before; PRE_ROLL].as_flattened());
        assert_eq!(
            &audio[PRE_ROLL * 160..(PRE_ROLL + 4) * 160],
            [hiss(); 4].as_flattened()
        );
    }

    #[test]
    fn training_keeps_post_hit_pcm_without_waiting_frames_or_asr_padding() {
        let mut ring = VecDeque::from([hiss(); PRE_ROLL]);
        let mut turn = Turn::start(&mut ring);
        for frame in [hiss(), hiss(), vowel(), vowel()] {
            turn.push(&frame);
        }
        finish_after_speech(&mut turn);
        let original = turn.training_audio().to_vec();
        assert_eq!(original.len(), (4 + END_SILENCE) * 160);
        assert_eq!(&original[..320], [hiss(), hiss()].as_flattened());
        assert_eq!(&original[320..480], vowel());
        let crop = turn.training_crop();
        assert_eq!(crop["start_sample"], 160);
        assert_eq!(crop["leading_silence_samples"], ONSET_PAD);
        assert_eq!(crop["sample_count"], original.len() - 160);
        assert_eq!(&turn.command_audio()[ONSET_PAD..], &original[160..]);
    }

    #[test]
    fn keeps_acoustic_overlap_and_stops_on_silence_or_maximum_duration() {
        let mut ring = VecDeque::from([[901; 160]; PRE_ROLL]);
        let mut take = Turn::start(&mut ring);
        assert!(ring.is_empty());
        assert_eq!(&take.pcm[3200..], vec![901; PRE_ROLL * 160]);
        for _ in 0..20 {
            assert!(!take.push(&[-600; 160]));
        }
        for _ in 1..END_SILENCE {
            assert!(!take.push(&[60; 160]));
        }
        assert!(take.push(&[60; 160]));
        let mut only_name = Turn::start(&mut ring);
        for _ in 0..12 {
            assert!(!only_name.push(&[-600; 160]));
        }
        for _ in 1..200 {
            assert!(!only_name.push(&[0; 160]));
        }
        assert!(only_name.push(&[0; 160]));
        assert!(!only_name.has_command());
        let mut long = Turn::start(&mut ring);
        assert_eq!(
            (1..=MAX_TURN).find(|_| long.push(&[1000; 160])),
            Some(MAX_TURN)
        );
    }

    #[test]
    fn removes_only_the_leading_whole_name() {
        for (actual, command) in [
            ("РЕЙДЖ, открой настройки.", "открой настройки."),
            ("Рейж, открой настройки.", "открой настройки."),
            ("«Рэйдж» — проверь Рейдж", "проверь Рейдж"),
            ("rage!", ""),
            ("Рейдж, --help", "--help"),
            ("Открой настройки.", "Открой настройки."),
            ("рейджер открой", "рейджер открой"),
            ("позови Рейдж", "позови Рейдж"),
        ] {
            assert_eq!(strip_name(actual), command);
        }
    }
}
