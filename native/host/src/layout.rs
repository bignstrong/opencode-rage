use crate::Orb;
use napi::bindgen_prelude::Utf16String;
use napi_derive::napi;

#[napi]
impl Orb {
    /// Generate and crop in the same call. An orb frame contains 15 single-cell BMP glyphs.
    #[napi]
    pub fn layout_frame(&mut self, columns: f64) -> String {
        let frame = self.0.frame();
        let width = if columns < 45.0 {
            3
        } else if columns < 80.0 {
            9
        } else {
            15
        };
        let mut visible = if width == 15 {
            frame
        } else {
            frame.chars().skip((15 - width) / 2).take(width).collect()
        };
        if visible.bytes().all(|c| c == b' ') {
            visible.replace_range(width / 2..width / 2 + 1, "·");
        }
        visible
    }
}

fn trimmed(mut s: &[u16]) -> &[u16] {
    // JS trim includes BOM but not NEL. Compare UTF-16 so distinct host labels stay distinct.
    let space = |c: &u16| {
        matches!(c, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 |
        0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
    };
    while s.first().is_some_and(space) {
        s = &s[1..];
    }
    while s.last().is_some_and(space) {
        s = &s[..s.len() - 1];
    }
    s
}

/// Host supplies eligible direct text siblings, preserving their order.
#[napi]
pub fn dock_command_index(key: Utf16String, texts: Vec<Utf16String>) -> Option<u32> {
    let label: Vec<_> = key
        .iter()
        .copied()
        .chain(" commands".encode_utf16())
        .collect();
    let label = trimmed(&label);
    let mut matches = texts
        .iter()
        .enumerate()
        .filter(|(_, text)| trimmed(text) == label);
    let (index, _) = matches.next()?;
    if matches.next().is_none() {
        u32::try_from(index).ok()
    } else {
        None
    }
}
