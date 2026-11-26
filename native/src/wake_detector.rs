use std::borrow::Cow;
use std::f32::consts::TAU;
use std::io::Read;
use std::path::Path;

const HOP: usize = 160;
const FFT: usize = 256;
const BANDS: usize = 16;
const CONTRAST_CUTOFF: f32 = 5.75;
const EDGES: [usize; BANDS + 1] = [
    2, 4, 6, 8, 11, 14, 18, 22, 27, 33, 40, 48, 58, 71, 86, 104, 128,
];
type Feature = [i8; BANDS];
type Probe = Vec<(Feature, bool)>;

struct Spectrum {
    previous: [i16; FFT - HOP],
    window: [f32; FFT],
    twiddle: [(f32, f32); FFT / 2],
}

impl Spectrum {
    fn new() -> Self {
        Self {
            previous: [0; FFT - HOP],
            window: std::array::from_fn(|i| 0.5 - 0.5 * (TAU * i as f32 / FFT as f32).cos()),
            twiddle: std::array::from_fn(|i| (-TAU * i as f32 / FFT as f32).sin_cos()),
        }
    }

    fn extract(&mut self, pcm: &[i16]) -> Feature {
        let mut re = [0.0; FFT];
        let mut im = [0.0; FFT];
        for (i, &s) in self.previous.iter().chain(pcm).enumerate() {
            let j = i.reverse_bits() >> (usize::BITS - FFT.ilog2());
            re[j] = s as f32 * self.window[i];
        }
        self.previous.copy_from_slice(&pcm[2 * HOP - FFT..]);
        let mut half = 1;
        while half < FFT {
            let step = FFT / (2 * half);
            for i in (0..FFT).step_by(2 * half) {
                for k in 0..half {
                    let a = i + k;
                    let b = a + half;
                    let (s, c) = self.twiddle[k * step];
                    let x = c * re[b] - s * im[b];
                    let y = s * re[b] + c * im[b];
                    re[b] = re[a] - x;
                    im[b] = im[a] - y;
                    re[a] += x;
                    im[a] += y;
                }
            }
            half *= 2;
        }
        let powers = std::array::from_fn::<_, BANDS, _>(|b| {
            let range = EDGES[b]..EDGES[b + 1];
            range
                .clone()
                .map(|i| re[i] * re[i] + im[i] * im[i])
                .sum::<f32>()
                / range.len() as f32
        });
        let peak = powers.iter().copied().fold(1., f32::max);
        // A relative floor keeps inaudible bins from dominating the distance.
        powers.map(|p| ((p.max(peak * 0.0001) / peak).log10() * 20.).round() as i8)
    }
}

struct Matcher {
    frames: Cow<'static, [u8]>,
    prev: Vec<f32>,
    older: Vec<f32>,
    next: Vec<f32>,
}

impl Matcher {
    fn new(frames: Cow<'static, [u8]>) -> Self {
        let n = frames.len() / BANDS + 1;
        let row = || {
            let mut v = vec![f32::INFINITY; n];
            v[0] = 0.;
            v
        };
        Self {
            frames,
            prev: row(),
            older: row(),
            next: row(),
        }
    }

    // Subsequence DTW: restart at any frame; local tempo must stay within 0.5–2x.
    fn score(&mut self, f: &Feature) -> f32 {
        let mut previous_cost = 0.;
        for (i, frame) in self.frames.as_chunks::<BANDS>().0.iter().enumerate() {
            let cost = frame
                .iter()
                .zip(f)
                .map(|(&a, &b)| (a as i8 as i32 - b as i32).abs())
                .sum::<i32>() as f32
                / BANDS as f32;
            let mut best = self.prev[i].min(self.older[i]) + cost;
            if i > 0 {
                best = best.min(self.prev[i - 1] + previous_cost + cost);
            }
            self.next[i + 1] = best;
            previous_cost = cost;
        }
        std::mem::swap(&mut self.prev, &mut self.older);
        std::mem::swap(&mut self.prev, &mut self.next);
        self.prev[self.prev.len() - 1] / (self.prev.len() - 1) as f32
    }
}

/// Streaming detector for 16 kHz mono PCM. Returns one event when the word ends.
pub struct Detector {
    spectrum: Spectrum,
    matchers: [[Matcher; 5]; 3],
    personal: Vec<Matcher>,
    rejects: Vec<Matcher>,
    recent: [(f32, f32); 13],
    cursor: usize,
    cooldown: usize,
    contrast_cutoff: f32,
}

impl Detector {
    pub fn new() -> Self {
        // Trusted compile-time bank: frame count byte, then 16 signed band levels per frame.
        let mut bank = include_bytes!("../wake-assets/milena.bank").as_slice();
        let matchers = std::array::from_fn(|_| {
            std::array::from_fn(|_| {
                let (frame_count, rest) = bank.split_first().expect("missing wake template");
                let (frames, tail) = rest.split_at(usize::from(*frame_count) * BANDS);
                bank = tail;
                Matcher::new(Cow::Borrowed(frames))
            })
        });
        assert!(bank.is_empty(), "extra wake template data");
        Self {
            spectrum: Spectrum::new(),
            matchers,
            personal: Vec::new(),
            rejects: Vec::new(),
            recent: [(f32::INFINITY, f32::INFINITY); 13],
            cursor: 0,
            cooldown: 0,
            contrast_cutoff: CONTRAST_CUTOFF,
        }
    }

    /// Load only explicitly selected, local examples. Nothing is written.
    pub fn from_wav_dir(dir: &Path) -> Result<Self, String> {
        let mut detector = Self::new();
        let (mut positives, mut negatives) = (Vec::new(), Vec::new());
        for (i, entry) in std::fs::read_dir(dir)
            .map_err(|e| format!("Wake profile directory: {e}"))?
            .enumerate()
        {
            if i >= 64 {
                return Err("Too many entries in wake profile directory".into());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
            {
                continue;
            }
            if detector.personal.len() + detector.rejects.len() == 8 {
                return Err("Wake profile accepts at most 8 WAV files".into());
            }
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                return Err("Wake examples must be regular WAV files, not links".into());
            }
            let (features, probe) = load_example(&path)
                .map_err(|e| format!("{}: {e}", entry.file_name().to_string_lossy()))?;
            let m = Matcher::new(Cow::Owned(features));
            if entry.file_name().to_string_lossy().starts_with("reject-") {
                detector.rejects.push(m);
                negatives.push(probe);
            } else {
                detector.personal.push(m);
                positives.push(probe);
            }
        }
        if detector.personal.len() < 3 {
            return Err("Wake profile requires 3–8 WAV examples".into());
        }
        detector.contrast_cutoff = detector.calibrate_cutoff(&positives, &negatives);
        Ok(detector)
    }

    fn calibrate_cutoff(&self, positives: &[Probe], negatives: &[Probe]) -> f32 {
        // A single contrast can't check against a different confusable.
        if positives.len() < 4 || negatives.len() < 2 {
            return CONTRAST_CUTOFF;
        }
        let score = |skip_positive, skip_negative, probe: &Probe| {
            let fresh = |models: &[Matcher], skip| {
                models
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| Some(*i) != skip)
                    .map(|(_, m)| Matcher::new(m.frames.clone()))
                    .collect()
            };
            let mut fold = Self::new();
            fold.personal = fresh(&self.personal, skip_positive);
            fold.rejects = fresh(&self.rejects, skip_negative);
            probe.iter().fold(f32::INFINITY, |best, (f, audible)| {
                best.min(fold.personal_score(f, *audible, true))
            })
        };
        let negative_floor = negatives
            .iter()
            .enumerate()
            .map(|(i, probe)| score(None, Some(i), probe))
            .fold(f32::INFINITY, f32::min);
        enrollment_cutoff(
            positives
                .iter()
                .enumerate()
                .map(|(i, probe)| score(Some(i), None, probe)),
            negative_floor,
        )
    }

    pub fn reset(&mut self) {
        self.spectrum.previous.fill(0);
        for m in self
            .matchers
            .iter_mut()
            .flatten()
            .chain(&mut self.personal)
            .chain(&mut self.rejects)
        {
            m.prev[1..].fill(f32::INFINITY);
            m.older[1..].fill(f32::INFINITY);
        }
        self.cooldown = 0;
        self.recent.fill((f32::INFINITY, f32::INFINITY));
        self.cursor = 0;
    }

    pub fn push(&mut self, frame: &[i16]) -> bool {
        if frame.len() != HOP {
            self.reset();
            return false;
        }
        let f = self.spectrum.extract(frame);
        let audible = audible(frame);
        let mut best = f32::INFINITY;
        let mut negative = f32::INFINITY;
        let matched = if self.personal.is_empty() {
            for bank in &mut self.matchers {
                let [isolated, before_n, before_d, rech, reis] =
                    bank.each_mut().map(|m| m.score(&f));
                // The voiced ending is less distinctive; require a closer match for it.
                best = best.min(isolated).min(before_n).min(before_d + 2.8);
                negative = negative.min(rech).min(reis);
            }
            audible && best < 7.1 && best + 0.8 < negative
        } else {
            let contrast = !self.rejects.is_empty();
            let score = self.personal_score(&f, audible, contrast);
            if contrast {
                score < self.contrast_cutoff
            } else {
                score < 5.4
            }
        };
        if self.cooldown > 0 {
            self.cooldown -= 1;
            return false;
        }
        if matched {
            self.cooldown = 80;
            return true;
        }
        false
    }

    fn personal_score(&mut self, f: &Feature, audible: bool, contrast: bool) -> f32 {
        let (mut best, mut second) = (f32::INFINITY, f32::INFINITY);
        for m in &mut self.personal {
            let s = m.score(f);
            second = second.min(best.max(s));
            best = best.min(s);
        }
        // Require agreement between two enrollment takes.
        let best = if audible && second < 7.5 {
            best
        } else {
            f32::INFINITY
        };
        if !contrast {
            return best;
        }
        let negative = self
            .rejects
            .iter_mut()
            .fold(f32::INFINITY, |n, m| n.min(m.score(f)));
        // A confusable can finish a few frames after the provisional positive.
        self.recent[self.cursor] = (best, negative);
        self.cursor = (self.cursor + 1) % self.recent.len();
        let positive = self.recent[(self.cursor + 6) % self.recent.len()].0;
        if self.recent.iter().all(|&(_, s)| positive + 1.0 < s) {
            positive
        } else {
            f32::INFINITY
        }
    }
}

impl Default for Detector {
    fn default() -> Self {
        Self::new()
    }
}

fn audible(frame: &[i16]) -> bool {
    frame.iter().any(|x| x.unsigned_abs() > 64)
}

fn enrollment_cutoff(positive_scores: impl Iterator<Item = f32>, negative_floor: f32) -> f32 {
    let cap = (negative_floor - 0.25).min(7.25);
    positive_scores
        // Accept the observed match despite the strict comparison at runtime.
        .map(|s| s + 0.02)
        .filter(|&cutoff| cutoff <= cap)
        .fold(CONTRAST_CUTOFF, f32::max)
}

fn load_example(path: &Path) -> Result<(Vec<u8>, Probe), String> {
    const MAX_FILE: u64 = 800_000;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let invalid = "Expected a 16-bit PCM mono WAV (8–96 kHz, up to 4 s)";
    if bytes.len() as u64 > MAX_FILE
        || bytes.get(..4) != Some(b"RIFF")
        || bytes.get(8..12) != Some(b"WAVE")
    {
        return Err(invalid.into());
    }
    let u32le = |s: &[u8]| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize;
    if u32le(&bytes[4..]) != bytes.len() - 8 {
        return Err("Invalid WAV container length".into());
    }
    let (mut rate, mut data) = (None, None);
    let mut pos = 12;
    while pos < bytes.len() {
        let header = bytes.get(pos..pos + 8).ok_or(invalid)?;
        let len = u32le(&header[4..]);
        pos += 8;
        let chunk = bytes.get(pos..pos + len).ok_or(invalid)?;
        match &header[..4] {
            b"fmt " => {
                if rate.is_some()
                    || len < 16
                    || chunk[..4] != [1, 0, 1, 0]
                    || chunk[12..16] != [2, 0, 16, 0]
                {
                    return Err(invalid.into());
                }
                rate = Some(u32le(&chunk[4..]));
            }
            b"data" if data.is_none() => data = Some(chunk),
            b"data" => return Err("Duplicate WAV data chunk".into()),
            _ => (),
        }
        pos += len + (len & 1);
    }
    let rate = rate.filter(|r| (8000..=96000).contains(r)).ok_or(invalid)?;
    let data = data.ok_or(invalid)?;
    if data.len() % 2 != 0 || data.len() > 8 * rate {
        return Err(invalid.into());
    }
    let samples: Vec<_> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&s| i16::from_le_bytes(s))
        .collect();
    let mut pcm = Vec::with_capacity(samples.len() * 16_000 / rate);
    for i in 0..samples.len() * 16_000 / rate {
        let j = i * rate / 16_000;
        let frac = ((i * rate) % 16_000) as i32;
        let a = i32::from(samples[j]);
        let b = i32::from(*samples.get(j + 1).unwrap_or(&samples[j]));
        pcm.push((a + (b - a) * frac / 16_000) as i16);
    }
    let energy: Vec<_> = pcm
        .as_chunks::<HOP>()
        .0
        .iter()
        .map(|f| (f.iter().map(|&x| (x as f32).powi(2)).sum::<f32>() / HOP as f32).sqrt())
        .collect();
    let peak = energy.iter().copied().fold(0., f32::max);
    let gate = 64_f32.max(peak * 0.025);
    let (start, end) =
        example_bounds(&energy, gate).ok_or("Wake example is silent or too quiet")?;
    if !(15..=150).contains(&(end - start)) {
        return Err("Speak just the wake word (0.15–1.5 s of speech)".into());
    }
    let mut spectrum = Spectrum::new();
    let template = pcm[start * HOP..end * HOP]
        .as_chunks::<HOP>()
        .0
        .iter()
        .flat_map(|frame| spectrum.extract(frame).map(|x| x as u8))
        .collect();
    let mut spectrum = Spectrum::new();
    let silence = [0; HOP];
    let (frames, tail) = pcm.as_chunks::<HOP>();
    let mut last = silence;
    last[..tail.len()].copy_from_slice(tail);
    let probe = std::iter::repeat_n(&silence, 20)
        .chain(frames)
        .chain((!tail.is_empty()).then_some(&last))
        .chain(std::iter::repeat_n(&silence, 31))
        .map(|frame| (spectrum.extract(frame), audible(frame)))
        .collect();
    Ok((template, probe))
}

fn example_bounds(energy: &[f32], gate: f32) -> Option<(usize, usize)> {
    let mut spans = Vec::new();
    for (index, &rms) in energy.iter().enumerate() {
        if rms < gate {
            continue;
        }
        match spans.last_mut() {
            Some((_, end, count)) if index < *end + 15 => {
                *end = index + 1;
                *count += 1;
            }
            _ => spans.push((index, index + 1, 1)),
        }
    }
    let &(first, _, _) = spans.first()?;
    let last = spans.last()?.1;
    // Ignore disconnected short bursts only when exactly one span has sustained activity.
    let mut sustained = spans.iter().filter(|&&(_, _, count)| count >= 15);
    Some(match (sustained.next(), sustained.next()) {
        (Some(&(start, end, _)), None) => (start, end),
        _ => (first, last),
    })
}

#[cfg(test)]
mod tests {
    use super::{CONTRAST_CUTOFF, Detector, enrollment_cutoff, example_bounds};

    #[test]
    fn enrollment_cutoff_keeps_a_margin_from_held_out_contrasts() {
        assert_eq!(enrollment_cutoff([5.0, 6.0, 6.8].into_iter(), 6.5), 6.02);
        assert_eq!(
            enrollment_cutoff([6.8, 7.3].into_iter(), f32::INFINITY),
            6.82
        );
        assert_eq!(enrollment_cutoff([6.0].into_iter(), 6.25), CONTRAST_CUTOFF);
        assert_eq!(Detector::new().calibrate_cutoff(&[], &[]), CONTRAST_CUTOFF);
    }

    #[test]
    fn trims_short_bursts_before_and_after_sustained_activity() {
        let mut energy = [1.; 140];
        energy[3..9].fill(80.);
        energy[60..75].fill(80.);
        energy[82..100].fill(80.);
        energy[128..134].fill(80.);
        assert_eq!(example_bounds(&energy, 64.), Some((60, 100)));
    }

    #[test]
    fn preserves_bounds_when_no_unique_sustained_span_exists() {
        let mut energy = [0.; 80];
        assert_eq!(example_bounds(&energy, 64.), None);
        energy[2..16].fill(80.);
        energy[60..74].fill(80.);
        assert_eq!(example_bounds(&energy, 64.), Some((2, 74)));
        energy[16] = 80.;
        energy[74] = 80.;
        assert_eq!(example_bounds(&energy, 64.), Some((2, 75)));
    }
}
