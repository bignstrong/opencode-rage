use napi_derive::napi;
use std::collections::{HashMap, VecDeque, hash_map::Entry};

#[derive(PartialEq, Eq, Hash)]
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
pub struct Drafts(HashMap<Destination, VecDeque<String>>);

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
            .entry(origin(session, directory, workspace))
            .or_default()
            .push_back(text);
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
        self.0.get(&dest).and_then(VecDeque::front).cloned()
    }

    #[napi]
    pub fn inserted(
        &mut self,
        session: Option<String>,
        directory: Option<String>,
        workspace: Option<String>,
    ) {
        let dest = origin(session, directory, workspace);
        if let Entry::Occupied(mut queue) = self.0.entry(dest) {
            let pending = queue.get_mut();
            pending.pop_front();
            if pending.is_empty() {
                queue.remove();
            }
        }
    }

    #[napi]
    pub fn clear(&mut self) {
        self.0.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::Drafts;

    #[test]
    fn drafts_stay_in_order_until_their_own_destination_acknowledges_them() {
        let mut drafts = Drafts::new();
        drafts.push("first".into(), Some("s1".into()), None, None);
        drafts.push("other".into(), Some("s2".into()), None, None);
        drafts.push(
            "home".into(),
            None,
            Some("/project".into()),
            Some("w1".into()),
        );
        drafts.push("second".into(), Some("s1".into()), None, None);

        for _ in 0..2 {
            assert_eq!(
                drafts.next(Some("s1".into()), None, None).as_deref(),
                Some("first")
            );
        }
        drafts.inserted(Some("s1".into()), None, None);
        assert_eq!(
            drafts.next(Some("s1".into()), None, None).as_deref(),
            Some("second")
        );
        drafts.inserted(Some("s1".into()), None, None);
        assert_eq!(drafts.next(Some("s1".into()), None, None), None);
        assert_eq!(drafts.0.len(), 2);
        assert_eq!(
            drafts.next(Some("s2".into()), None, None).as_deref(),
            Some("other")
        );
        assert_eq!(
            drafts.next(None, Some("/project".into()), Some("w2".into())),
            None
        );
        assert_eq!(
            drafts
                .next(None, Some("/project".into()), Some("w1".into()))
                .as_deref(),
            Some("home")
        );
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
