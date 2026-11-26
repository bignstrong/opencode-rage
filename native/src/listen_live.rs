//! One verified AVFoundation stream. Only inventory is rescanned; PCM stays in pipes.
use super::*;
use std::os::fd::AsRawFd;
use std::process::ChildStdout;

pub(crate) struct Live {
    proc: Process,
    pcm: ChildStdout,
    binary: OsString,
    device: Device,
    log: Arc<Mutex<Log>>,
    scan: Option<Scan>,
    next_scan: Instant,
    progress: Instant,
    started: bool,
    partial: [u8; 320],
    used: usize,
}

impl Live {
    pub(crate) fn open(
        input: &str,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        if matches!(input.trim(), "" | "default" | ":default") {
            return Err("Choose an explicit microphone for wake listening".into());
        }
        let binary = ffmpeg().unwrap_or_else(|_| "ffmpeg".into());
        let rows = scan(&binary, &mut check)?;
        // Bind a legacy index to its actual device before opening it.
        let index = input.strip_prefix(':').unwrap_or(input);
        let selector = if numeric(index) {
            rows.iter()
                .find(|d| d.index == index)
                .ok_or_else(|| unavailable(input, "Unknown device index."))?
                .selector()
        } else {
            input.to_owned()
        };
        let (source, device) = select(Some(&selector), || Ok(rows))?;
        let device = device.ok_or("Wake listening requires a specific microphone")?;
        let mut cmd = Command::new(&binary);
        cmd.args([
            "-hide_banner",
            "-nostats",
            "-nostdin",
            "-loglevel",
            "level+debug",
            "-f",
            "avfoundation",
        ]);
        if let Some(uid) = &device.uid {
            cmd.args(["-audio_device_id", &format!("uid:{uid}")]);
        }
        check()?;
        let mut proc = Process(
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
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(err)?,
        );
        let pcm = proc.0.stdout.take().ok_or("Missing microphone PCM pipe")?;
        let stderr = proc
            .0
            .stderr
            .take()
            .ok_or("Missing microphone diagnostics")?;
        let log = Arc::new(Mutex::new(Log::default()));
        let shared = Arc::clone(&log);
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = Vec::new();
            loop {
                line.clear();
                if !matches!(
                    (&mut reader).take(8192).read_until(b'\n', &mut line),
                    Ok(1..)
                ) || line.len() == 8192
                {
                    break;
                }
                let line = String::from_utf8_lossy(&line);
                let msg = message(&line);
                let mut state = shared.lock().unwrap();
                if ["[error]", "[fatal]", "[panic]"].iter().any(|tag| {
                    msg.starts_with(tag)
                        || msg
                            .split_once("] ")
                            .is_some_and(|(_, detail)| detail.starts_with(tag))
                }) {
                    state.failure = Some(msg.trim().chars().take(512).collect());
                }
                let detail = msg
                    .strip_prefix('[')
                    .and_then(|s| s.split_once("] "))
                    .map_or(msg, |(_, rest)| rest)
                    .trim();
                state.line(detail);
            }
            shared
                .lock()
                .unwrap()
                .failure
                .get_or_insert_with(|| "Microphone diagnostic stream lost".into());
        });
        let now = Instant::now();
        Ok(Self {
            proc,
            pcm,
            binary,
            device,
            log,
            scan: None,
            next_scan: now + RESCAN,
            progress: now,
            started: false,
            partial: [0; 320],
            used: 0,
        })
    }

    pub(crate) fn verify_before_delivery(
        &mut self,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        self.scan = Some(Scan::start(&self.binary)?);
        while self.scan.is_some() {
            check()?;
            self.poll()?;
            if self.scan.is_some() {
                thread::sleep(Duration::from_millis(5));
            }
        }
        Ok(())
    }

    pub(crate) fn poll(&mut self) -> Result<Option<[i16; 160]>, String> {
        if let Some(status) = self.proc.0.try_wait().map_err(err)? {
            return Err(unavailable(
                &self.device.name,
                &format!("Microphone stream exited ({status})."),
            ));
        }
        let verified = {
            let log = self
                .log
                .lock()
                .map_err(|_| "Microphone diagnostics failed")?;
            if let Some(failure) = &log.failure {
                return Err(unavailable(&self.device.name, failure));
            }
            if log.switched || log.opened.as_ref().is_some_and(|s| *s != self.device.name) {
                return Err(unavailable(
                    &self.device.name,
                    "Different microphone opened.",
                ));
            }
            log.opened.is_some()
        };
        if self.scan.is_none() && Instant::now() >= self.next_scan {
            self.scan = Some(Scan::start(&self.binary)?);
        }
        if let Some(scan) = &mut self.scan
            && let Some(rows) = scan.poll()?
        {
            let matching = rows
                .iter()
                .filter(|row| {
                    self.device.uid.as_ref().map_or_else(
                        || row.name == self.device.name,
                        |uid| row.uid.as_ref() == Some(uid),
                    )
                })
                .count();
            if matching != 1 {
                return Err(unavailable(&self.device.name, "Selected input lost."));
            }
            self.scan = None;
            self.next_scan = Instant::now() + RESCAN;
        }
        if self.progress.elapsed()
            >= if self.started {
                STALL_TIMEOUT
            } else {
                START_TIMEOUT
            }
        {
            return Err(unavailable(
                &self.device.name,
                "Timed out waiting for verified audio.",
            ));
        }
        if !verified {
            return Ok(None);
        }
        let mut fd = libc::pollfd {
            fd: self.pcm.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: fd borrows the owned pipe; poll writes one initialized pollfd.
        let ready = unsafe { libc::poll(&mut fd, 1, 0) };
        if ready == -1 {
            return Err(err(io::Error::last_os_error()));
        }
        if ready == 0 {
            return Ok(None);
        }
        if fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(unavailable(
                &self.device.name,
                "Microphone PCM stream lost.",
            ));
        }
        let n = self.pcm.read(&mut self.partial[self.used..]).map_err(err)?;
        if n == 0 {
            return Err(unavailable(&self.device.name, "Microphone stopped."));
        }
        self.used += n;
        if self.used != self.partial.len() {
            return Ok(None);
        }
        self.progress = Instant::now();
        self.started = true;
        self.used = 0;
        Ok(Some(crate::listen::samples(&self.partial)))
    }
}
