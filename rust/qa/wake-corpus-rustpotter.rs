// Optional comparator, not linked by rage-core. See native/wake-assets/README.md.
use rustpotter::{Rustpotter, RustpotterConfig, WakewordRef, WakewordRefBuildFromFiles};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let files = std::fs::read_dir(&args[1])
        .unwrap()
        .map(|f| f.unwrap().path().to_str().unwrap().to_owned())
        .collect();
    let reference =
        WakewordRef::new_from_sample_files("Рейдж".into(), None, None, files, 16).unwrap();
    let mut spotter = Rustpotter::new(&RustpotterConfig::default()).unwrap();
    spotter.add_wakeword_ref("rage", reference).unwrap();
    let pcm: Vec<_> = std::fs::read(&args[2])
        .unwrap()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&v| i16::from_le_bytes(v))
        .collect();
    let size = spotter.get_samples_per_frame();
    for (i, frame) in pcm.chunks_exact(size).enumerate() {
        if spotter.process_samples(frame.to_vec()).is_some() {
            println!("{}", (i + 1) * size / 16);
        }
    }
}
