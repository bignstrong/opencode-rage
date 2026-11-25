use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

// Never hand the caller's original to a filter or a third-party speech engine.
pub fn copy(path: &Path) -> io::Result<tempfile::NamedTempFile> {
    let mut dst = tempfile::Builder::new().suffix(".wav").tempfile()?;
    io::copy(&mut File::open(path)?, &mut dst)?;
    repair(dst.as_file_mut())?;
    Ok(dst)
}

fn repair(file: &mut File) -> io::Result<()> {
    let len = file.metadata()?.len();
    if len < 12 || len - 8 > u64::from(u32::MAX) {
        return Ok(());
    }
    file.rewind()?;
    let mut riff = [0; 12];
    file.read_exact(&mut riff)?;
    if &riff[..4] != b"RIFF" || &riff[8..] != b"WAVE" {
        return Ok(());
    }
    let size = |b: &[u8]| u64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let mut pos = 12;
    while pos + 8 <= len {
        file.seek(SeekFrom::Start(pos))?;
        let mut chunk = [0; 8];
        file.read_exact(&mut chunk)?;
        let declared = size(&chunk[4..]);
        if &chunk[..4] == b"data" {
            let available = len - pos - 8;
            for (offset, old, new) in [
                (pos + 4, declared, available),
                (4, size(&riff[4..]), len - 8),
            ] {
                if old > new {
                    file.seek(SeekFrom::Start(offset))?;
                    file.write_all(&(new as u32).to_le_bytes())?;
                }
            }
            break;
        }
        pos += 8 + declared + declared % 2;
    }
    Ok(())
}
