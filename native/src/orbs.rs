const GLYPHS: &str = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝЖЯЮБФДЛЦШЩЭЗЧЫЙбзфжλΨφΣξΩβγζηθμπτχδΛπÆØÐÞßøæƒµ0123456789@&%#?§±÷≠≈∑∂∇∆∫∝∞∴∵∷※∗⊕⊗⊙⊥∩∪";
const RADIUS: [usize; 16] = [0, 1, 2, 4, 5, 6, 7, 7, 7, 6, 5, 4, 3, 2, 1, 0];

struct Bag {
    seed: u64,
    chars: Vec<char>,
    at: usize,
}

impl Bag {
    fn pick(&mut self, max: usize) -> usize {
        self.seed = self.seed * 48271 % 2147483647;
        (self.seed * max as u64 / 2147483647) as usize
    }

    fn glyph(&mut self) -> char {
        if self.at == self.chars.len() {
            let tail = self.at - 24;
            for (start, end) in [(0, tail), (tail, self.at)] {
                for i in (1..end - start).rev() {
                    let j = self.pick(i + 1);
                    self.chars.swap(start + i, start + j);
                }
            }
            self.chars[24..].rotate_right(24);
            self.at = 0;
        }
        let c = self.chars[self.at];
        self.at += 1;
        c
    }
}

pub struct Animation {
    bag: Bag,
    lanes: [(usize, usize, char); 15],
    mode: String,
    tick: usize,
}

impl Animation {
    pub fn new(mode: &str, seed: u32) -> Result<Self, String> {
        if !matches!(mode, "cycle" | "breath" | "rain") {
            return Err("expected cycle, breath or rain".into());
        }
        let mut chars = Vec::new();
        for c in GLYPHS.chars() {
            if !chars.contains(&c) {
                chars.push(c);
            }
        }
        let mut bag = Bag {
            seed: u64::from(seed),
            at: chars.len(),
            chars,
        };
        let lanes = std::array::from_fn(|_| (bag.pick(9), 6 + bag.pick(6), bag.glyph()));
        Ok(Self {
            bag,
            lanes,
            mode: mode.into(),
            tick: 0,
        })
    }

    pub fn frame(&mut self) -> String {
        let t = self.tick;
        self.tick = t.wrapping_add(1);
        let mode = self.mode.as_str();
        let bag = &mut self.bag;
        let lanes = &mut self.lanes;
        let breathe = mode == "breath" || (mode == "cycle" && t % 64 < 32);
        let r = RADIUS[t % 16];
        if breathe && t.is_multiple_of(16) {
            for (_, _, glyph) in lanes.iter_mut() {
                *glyph = bag.glyph();
            }
        }
        let mut frame = String::with_capacity(45);
        for (i, (age, rest, glyph)) in lanes.iter_mut().enumerate() {
            let d = i.abs_diff(7);
            frame.push(if breathe {
                match d {
                    0 if r == 0 => '·',
                    0 if r < 4 => '•',
                    0 => '●',
                    d if d > r => ' ',
                    d if d == r && i < 7 => '⟨',
                    d if d == r => '⟩',
                    _ => *glyph,
                }
            } else {
                *age += 1;
                if *age >= *rest {
                    *age = 0;
                    *glyph = bag.glyph();
                    *rest = 6 + bag.pick(6);
                }
                match age {
                    0 => '˙',
                    1 | 2 => *glyph,
                    3 => '₁',
                    4 => '.',
                    _ => ' ',
                }
            });
        }
        frame
    }
}
