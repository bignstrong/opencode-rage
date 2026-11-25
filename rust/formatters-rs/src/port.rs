#![forbid(unsafe_code)]

const MIB: f64 = 1024.0 * 1024.0;
const GIB: f64 = MIB * 1024.0;

fn number(n: f64) -> String {
    ryu_js::Buffer::new().format(n).to_owned()
}

fn fixed(n: f64) -> String {
    ryu_js::Buffer::new().format_to_fixed(n, 1).to_owned()
}

pub fn format_bytes(value: f64) -> Result<String, String> {
    Ok(if value.is_nan() || value <= 0.0 {
        "0 MB".into()
    } else if value >= GIB {
        format!("{} GB", fixed(value / GIB))
    } else {
        format!("{} MB", (value / MIB).round().max(1.0))
    })
}

pub fn format_rate(bytes_per_second: f64) -> Result<String, String> {
    Ok(if bytes_per_second.is_nan() || bytes_per_second < 1.0 {
        "warming up".into()
    } else if bytes_per_second >= MIB {
        format!("{} MB/s", fixed(bytes_per_second / MIB))
    } else {
        format!("{} KB/s", (bytes_per_second / 1024.0).round().max(1.0))
    })
}

pub fn format_duration(seconds: f64) -> Result<String, String> {
    if !seconds.is_finite() || seconds < 1.0 {
        return Ok("calculating".into());
    }
    let total = seconds.ceil();
    let minutes = (total / 60.0).floor();
    let rest = number(total % 60.0);
    Ok(if minutes == 0.0 {
        format!("{rest}s")
    } else {
        format!("{}m {rest:0>2}s", number(minutes))
    })
}

pub fn progress_bar(percent: f64) -> Result<String, String> {
    if percent.is_nan() {
        return Ok(String::new());
    }
    let n = (percent / 100.0 * 34.0).round().clamp(0.0, 34.0) as usize;
    Ok("█".repeat(n) + &"░".repeat(34 - n))
}

pub fn progress_line(percent: f64) -> Result<String, String> {
    // Math.round chooses the larger integer on a negative half tie.
    let rounded = if percent.fract() == -0.5 {
        percent.ceil()
    } else {
        percent.round()
    };
    Ok(format!(
        "{}  {:>3}%",
        progress_bar(percent)?,
        number(rounded)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_rounding_at_ties() {
        assert_eq!(fixed(1.25), "1.3");
        assert!(progress_line(-1.5).unwrap().ends_with(" -1%"));
        assert!(progress_line(-0.5).unwrap().ends_with("  0%"));
    }
}
