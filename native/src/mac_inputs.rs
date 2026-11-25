#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Device {
    pub index: String,
    pub name: String,
    pub uid: Option<String>,
}

pub(crate) fn numeric(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

// Settings use JS encodeURIComponent, including its five unescaped punctuation marks.
fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) fn decode(s: &str) -> Option<String> {
    let mut bytes = s.bytes();
    let mut out = Vec::new();
    while let Some(b) = bytes.next() {
        out.push(if b == b'%' {
            let hi = (bytes.next()? as char).to_digit(16)?;
            let lo = (bytes.next()? as char).to_digit(16)?;
            (hi * 16 + lo) as u8
        } else {
            b
        });
    }
    String::from_utf8(out).ok()
}

impl Device {
    pub(crate) fn selector(&self) -> String {
        let name = &self.name;
        if let Some(uid) = &self.uid {
            format!(":uid:{}:{}", encode(uid), encode(name))
        } else if numeric(name)
            || name == "default"
            || name.starts_with(':')
            || name.starts_with("uid:")
        {
            format!("::{name}")
        } else {
            format!(":{name}")
        }
    }
}

pub(crate) fn message(line: &str) -> &str {
    let line = line.trim();
    if let Some((prefix, rest)) = line.split_once("] ")
        && prefix.starts_with('[')
        && prefix.to_ascii_lowercase().contains("avfoundation")
    {
        rest.trim()
    } else {
        line
    }
}

pub(crate) fn parse_list(text: &str) -> Result<Vec<Device>, String> {
    read_list(text, true)
}

pub(crate) fn read_list(text: &str, strict: bool) -> Result<Vec<Device>, String> {
    let (mut listed, mut audio) = (false, false);
    let mut rows = Vec::new();
    for line in text.lines().map(message) {
        if line.eq_ignore_ascii_case("AVFoundation audio devices:") {
            listed = true;
            audio = true;
        } else if line.eq_ignore_ascii_case("AVFoundation video devices:") {
            audio = false;
        } else if audio
            && line.starts_with('[')
            && line.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
        {
            let invalid = "Incomplete AVFoundation audio device entry";
            let Some((index, text)) = line[1..].split_once(']') else {
                if strict {
                    return Err(invalid.into());
                }
                continue;
            };
            if !numeric(index) || !text.starts_with(char::is_whitespace) {
                if strict {
                    return Err(invalid.into());
                }
                continue;
            }
            let (name, uid) = match text.trim().split_once("  [uid:") {
                None => (text.trim(), None),
                Some((name, tail)) => {
                    if let Some((uid, serial)) = tail.split_once(']')
                        && !uid.is_empty()
                        && (serial.is_empty()
                            || serial.starts_with(" [serial:") && serial.ends_with(']'))
                    {
                        (name.trim_end(), Some(uid.to_owned()))
                    } else if strict {
                        return Err(invalid.into());
                    } else {
                        (text.trim(), None)
                    }
                }
            };
            if name.is_empty() {
                if strict {
                    return Err(invalid.into());
                }
                continue;
            }
            rows.push(Device {
                index: index.into(),
                name: name.into(),
                uid,
            });
        }
    }
    (listed || !strict)
        .then_some(rows)
        .ok_or_else(|| "FFmpeg could not list AVFoundation audio inputs".into())
}
