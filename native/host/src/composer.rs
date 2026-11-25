use napi_derive::napi;
use std::collections::VecDeque;

#[derive(PartialEq)]
enum Destination {
    Session(String),
    Home(Option<String>, Option<String>),
}

fn origin(
    session: Option<String>,
    directory: Option<String>,
    workspace: Option<String>,
) -> Destination {
    match session {
        Some(s) => Destination::Session(s),
        None => Destination::Home(directory, workspace),
    }
}

#[napi]
#[derive(Default)]
pub struct Drafts(VecDeque<(Destination, String)>);

#[napi]
impl Drafts {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn push(
        &mut self,
        text: String,
        session: Option<String>,
        directory: Option<String>,
        workspace: Option<String>,
    ) {
        self.0
            .push_back((origin(session, directory, workspace), text));
    }

    // Keep the draft until the live editor confirms insertion.
    #[napi]
    pub fn next(
        &self,
        session: Option<String>,
        directory: Option<String>,
        workspace: Option<String>,
    ) -> Option<String> {
        let dest = origin(session, directory, workspace);
        self.0
            .iter()
            .find(|(d, _)| *d == dest)
            .map(|(_, text)| text.clone())
    }

    #[napi]
    pub fn inserted(
        &mut self,
        session: Option<String>,
        directory: Option<String>,
        workspace: Option<String>,
    ) {
        let dest = origin(session, directory, workspace);
        if let Some(index) = self.0.iter().position(|(d, _)| *d == dest) {
            self.0.remove(index);
        }
    }

    #[napi]
    pub fn clear(&mut self) {
        self.0.clear();
    }
}

#[napi(object)]
pub struct Footer {
    pub hint: String,
    pub voice: String,
    pub width: u32,
    pub voice_enabled: bool,
    pub send_enabled: bool,
}

#[napi(object)]
pub struct FooterInput {
    pub phase: String,
    pub ru: bool,
    pub focus: String,
    pub animate: bool,
    pub activity: String,
    pub now: f64,
    pub start: f64,
    pub can_send: bool,
}

#[napi]
pub fn activate_key(name: String, enabled: bool, plain_press: bool) -> bool {
    enabled && plain_press && matches!(name.as_str(), "return" | "space")
}

// A second click is still consumed; otherwise a parent control could handle it.
#[napi]
pub fn release_button(
    pressed: bool,
    enabled: bool,
    left: bool,
    dragging: bool,
    elapsed_ms: f64,
) -> &'static str {
    if !pressed || !enabled || !left || dragging {
        "ignore"
    } else if elapsed_ms < 400. {
        "consume"
    } else {
        "activate"
    }
}

#[napi]
pub fn footer_view(input: FooterInput) -> Footer {
    let FooterInput {
        phase,
        ru,
        focus,
        animate,
        activity,
        now,
        start,
        can_send,
    } = input;
    let phase = phase.as_str();
    let wave = ["⢀⣶⡀", "⢠⡟⢄", "⣰⠃⢸", "⡜⢀⣾", "⠁⣰⡏", "⢠⡞⠁"];
    let title = match if focus == "send" { "send" } else { phase } {
        "idle" => ["Record voice", "Диктовать"],
        "recording" => ["Stop", "Стоп"],
        "stopping" => ["Stopping…", "Останавливаю…"],
        "transcribing" => ["Transcribing…", "Распознаю речь…"],
        "sending" => ["Sending…", "Отправляю…"],
        "send" => ["Send", "Отправить"],
        _ => ["Preparing…", "Подготовка…"],
    }[usize::from(ru)];
    let hint = if phase == "recording" {
        let seconds = ((now - start) / 1_000.0).max(0.) as u64;
        let label = if !focus.is_empty() {
            title
        } else {
            wave[if animate {
                now as usize / 160 % wave.len()
            } else {
                0
            }]
        };
        format!("{label} {:02}:{:02} ", seconds / 60, seconds % 60)
    } else if focus.is_empty() {
        String::new()
    } else {
        format!("{title} ")
    };
    let expanded = phase == "transcribing" && animate;
    Footer {
        hint,
        voice: match phase {
            "idle" => "●".into(),
            "recording" => "■".into(),
            "transcribing" if expanded => activity,
            "transcribing" => "···".into(),
            _ => "…".into(),
        },
        width: if expanded { 15 } else { 3 },
        voice_enabled: matches!(phase, "idle" | "recording"),
        send_enabled: phase == "idle" && can_send,
    }
}
