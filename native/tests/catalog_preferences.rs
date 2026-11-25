#[path = "../src/catalog.rs"]
mod catalog;
#[path = "../src/preferences.rs"]
mod preferences;

use serde_json::{Value, json};

#[test]
fn missing_selection_cannot_replace_saved_id() {
    let unknown = json!({"id":"not-in-the-catalog"});
    assert_eq!(
        catalog::request("getModel", &unknown).unwrap()["id"],
        "whisper-small"
    );
    assert!(catalog::request("selectModel", &unknown).is_err());
    assert_eq!(
        preferences::request("normalizeSettings", &json!({"raw":{"model":unknown["id"]}})).unwrap()
            ["model"],
        unknown["id"]
    );
}

#[test]
#[ignore = "reference run: requires Node and the original JS modules (RAGE_REFERENCE_ROOT)"]
fn compare_to_original() {
    let scratch = tempfile::tempdir().unwrap();
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/catalog_preferences_reference.mjs"
        ))
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut count = 0;
    for line in std::str::from_utf8(&output.stdout).unwrap().lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        let op = case["op"].as_str().unwrap();
        let args = &case["args"];
        let actual = match catalog::request(op, args) {
            Err(e) if e.starts_with("Unknown catalog operation:") => preferences::request(op, args),
            result => result,
        }
        .unwrap_or_else(|e| panic!("{op}({args}): {e}"));
        assert_eq!(actual, case["expected"], "{op}({args})");
        count += 1;
    }
    println!("{count} baseline comparisons matched");
    assert!(count > 1000);
}
