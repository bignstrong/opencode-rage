// Compile standalone; exercise the exact production implementation without the host or a mic.
include!("../../native/src/wake_detector.rs");

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let bytes = std::fs::read(&args[2]).unwrap();
    let pcm: Vec<_> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&v| i16::from_le_bytes(v))
        .collect();
    let frames = pcm.as_chunks::<HOP>().0;
    match args[1].as_str() {
        "template" => {
            let mut spectrum = Spectrum::new();
            let mut out = Vec::new();
            let end: usize = args[3].parse().unwrap();
            for frame in frames.iter().take(end) {
                out.extend(spectrum.extract(frame).map(|i| i as u8));
            }
            std::fs::write(&args[4], out).unwrap();
        }
        "detect" => {
            let mut detector = match args.get(3) {
                Some(path) => {
                    Detector::from_wav_dir(std::path::Path::new(path)).unwrap_or_else(|error| {
                        eprintln!("{error}");
                        std::process::exit(2);
                    })
                }
                None => Detector::new(),
            };
            for (i, frame) in frames.iter().enumerate() {
                if detector.push(frame) {
                    println!("{}", (i + 1) * 10);
                }
            }
        }
        "scores" => {
            let mut detector = match args.get(3) {
                Some(p) => Detector::from_wav_dir(std::path::Path::new(p)).unwrap(),
                None => Detector::new(),
            };
            for (i, frame) in frames.iter().enumerate() {
                let feature = detector.spectrum.extract(frame);
                print!("{}", (i + 1) * 10);
                if detector.personal.is_empty() {
                    for m in detector.matchers.iter_mut().flatten() {
                        print!(" {:.2}", m.score(&feature));
                    }
                } else {
                    for m in detector.personal.iter_mut().chain(&mut detector.rejects) {
                        print!(" {:.2}", m.score(&feature));
                    }
                }
                println!();
            }
        }
        "reset" => {
            let mut detector = Detector::new();
            assert!(frames.len() >= 54);
            assert!(!frames[..23].iter().any(|f| detector.push(f)));
            detector.reset();
            assert!(
                !frames[23..].iter().any(|f| detector.push(f)),
                "matched across reset"
            );
            assert_eq!(frames.iter().filter(|&f| detector.push(f)).count(), 1);
            detector.reset();
            assert_eq!(
                frames.iter().filter(|&f| detector.push(f)).count(),
                1,
                "stale cooldown"
            );
        }
        _ => panic!("expected template or detect"),
    }
}
