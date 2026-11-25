use napi_derive::napi;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Starting,
    Recording,
    Stopping,
    Transcribing,
}

#[napi]
#[derive(Default)]
pub struct Session {
    phase: Phase,
    generation: u32,
    cancelled: bool,
    interrupted: bool,
    review: bool,
    submit: bool,
}

#[napi]
impl Session {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi(getter)]
    pub fn phase(&self) -> &'static str {
        match self.phase {
            Phase::Idle => "idle",
            Phase::Starting => "starting",
            Phase::Recording => "recording",
            Phase::Stopping => "stopping",
            Phase::Transcribing => "transcribing",
        }
    }
    #[napi(getter)]
    pub fn generation(&self) -> u32 {
        self.generation
    }
    #[napi(getter)]
    pub fn cancelled(&self) -> bool {
        self.cancelled
    }
    #[napi(getter)]
    pub fn review(&self) -> bool {
        self.review
    }
    #[napi(getter)]
    pub fn interrupted(&self) -> bool {
        self.interrupted
    }
    #[napi(getter)]
    pub fn send(&self) -> bool {
        self.submit && !self.review && !self.interrupted && !self.cancelled
    }

    // Readiness promises may re-enter the controller. Decide the next effect only after settlement.
    #[napi]
    pub fn prepare_step(
        &self,
        after: String,
        cached: bool,
        failed: bool,
    ) -> napi::Result<&'static str> {
        Ok(match after.as_str() {
            "begin" => "ensureEngineReady",
            _ if self.cancelled => "",
            "ensureEngineReady" | "ensureDownloaded" if failed && !cached => "setupFailed",
            "ensureEngineReady" | "ensureDownloaded" | "ensureRecorderReady" if failed => {
                "runtimeFailed"
            }
            "ensureEngineReady" if !cached => "ensureDownloaded",
            "ensureEngineReady" | "ensureDownloaded" => "ensureRecorderReady",
            "ensureRecorderReady" => "ready",
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "Unknown preparation step: {after}"
                )));
            }
        })
    }

    // Recheck cancellation across the final await of prepare, before the host opens the mic.
    #[napi]
    pub fn capture_intent(&self, auto_submit: bool) -> Option<bool> {
        (!self.cancelled).then_some(self.submit || auto_submit)
    }

    #[napi]
    pub fn start_notice(&self, hold: bool, explicit_submit: bool) -> &'static str {
        if self.review {
            ""
        } else if hold {
            "hold"
        } else if explicit_submit {
            "recordingSubmit"
        } else {
            "recordingCopy"
        }
    }

    #[napi]
    pub fn press(
        &mut self,
        command: String,
        submit: bool,
        review: bool,
        recording: bool,
        decoding: bool,
        pending: bool,
    ) -> &'static str {
        use Phase::*;
        let command = command.as_str();
        if command == "start" && self.phase == Starting {
            return "starting";
        }
        if matches!(command, "finish" | "stop") && self.phase == Stopping {
            return "stopping";
        }
        if decoding || self.phase == Transcribing {
            return "busy";
        }
        if command == "toggle" {
            if self.phase == Starting {
                return "starting";
            }
            if self.phase == Stopping {
                return "stopping";
            }
        }
        let finish = matches!(command, "finish" | "stop")
            || (command == "toggle" && (self.phase == Recording || recording));
        if finish {
            if self.phase != Recording {
                return "";
            }
            self.review |= review;
            self.submit = submit || (command != "stop" && pending);
            self.phase = Stopping;
            return "stop";
        }
        if self.phase != Idle || recording {
            return "";
        }
        self.phase = Starting;
        self.generation = self.generation.wrapping_add(1);
        self.cancelled = false;
        self.interrupted = false;
        self.review = review;
        self.submit = submit;
        "start"
    }

    // An old recorder may deliver its disconnect notification after a new take starts.
    #[napi]
    pub fn lost(&mut self, generation: u32) -> bool {
        if self.phase == Phase::Idle
            || generation != self.generation
            || self.cancelled
            || self.interrupted
        {
            return false;
        }
        self.interrupted = true;
        self.phase == Phase::Recording
    }
    #[napi]
    pub fn started(&mut self) {
        self.phase = Phase::Recording;
    }
    #[napi]
    pub fn abort_start(&mut self) {
        if self.phase == Phase::Starting {
            self.phase = Phase::Idle;
        }
    }
    #[napi]
    pub fn decoding(&mut self) {
        self.phase = Phase::Transcribing;
    }
    #[napi]
    pub fn complete(&mut self, recording: bool) {
        self.phase = if recording && !self.cancelled {
            Phase::Recording
        } else {
            Phase::Idle
        };
    }
    #[napi]
    pub fn cancel(&mut self) {
        self.cancelled = true;
        if self.phase == Phase::Recording {
            self.phase = Phase::Idle;
        }
    }
}
