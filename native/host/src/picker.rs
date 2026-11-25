use serde_json::{Value, json};

fn identity(value: &str) -> &str {
    if let Some((uid, name)) = value.strip_prefix(":uid:").and_then(|s| s.split_once(':'))
        && !uid.is_empty()
    {
        &value[..value.len() - name.len()]
    } else {
        value
    }
}

fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("Expected picker string: {key}"))
}

fn cursor_index(rows: &[(usize, &str)], cursor: Option<&str>) -> isize {
    cursor.map_or(0, |id| {
        rows.iter()
            .position(|(_, v)| identity(v) == id)
            .map_or(-1, |i| i as isize)
    })
}

pub fn request(op: &str, a: &Value) -> Result<Value, String> {
    if op == "identity" {
        return Ok(json!(identity(string(a, "value")?)));
    }
    let state = &a["state"];
    let mut cursor = state["cursor"].as_str();
    let mut pressed = state["pressed"].as_str();
    let mut filter = state["filter"].as_str().unwrap_or("");
    let replace = op == "refresh" && a["next"].is_array() && a["next"] != a["rows"];
    let source = if replace { &a["next"] } else { &a["rows"] };
    let source = source.as_array().ok_or("Expected picker rows")?;
    if op == "input" {
        filter = string(a, "text")?;
    }
    // ECMAScript trim includes BOM and excludes NEXT LINE.
    let query = filter
        .trim_matches(|c: char| c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace()))
        .to_lowercase();
    let mut rows = Vec::new();
    for (i, row) in source.iter().enumerate() {
        if string(row, "title")?.to_lowercase().contains(&query) {
            rows.push((i, string(row, "value")?));
        }
    }
    let mut handled = true;
    let mut choose = None;
    let mut close = false;
    let mut delta = 0;
    match op {
        "init" => cursor = Some(identity(string(a, "current")?)),
        "input" => {
            let index = cursor_index(&rows, cursor).max(0) as usize;
            cursor = rows.get(index).map(|(_, value)| identity(value));
        }
        "refresh" => {
            if cursor.is_none() && a["next"].is_array() {
                cursor = rows.first().map(|(_, value)| identity(value));
            }
        }
        "key" => match (string(a, "name")?, a["ctrl"].as_bool() == Some(true)) {
            ("up", _) | ("p", true) => delta = -1,
            ("down", _) | ("n", true) => delta = 1,
            ("escape", _) => close = true,
            ("return", _) => {
                choose = rows
                    .get(cursor_index(&rows, cursor) as usize)
                    .map(|(_, v)| *v)
            }
            _ => handled = false,
        },
        "scroll" => match a["direction"].as_str() {
            Some("up") => delta = -1,
            Some("down") => delta = 1,
            _ => {}
        },
        "down" => {
            if a["left"] == true {
                pressed = Some(identity(string(a, "value")?));
            }
        }
        "up" => {
            if a["left"] == true
                && a["dragging"] != true
                && Some(identity(string(a, "value")?)) == pressed
            {
                choose = rows
                    .iter()
                    .find(|(_, v)| Some(identity(v)) == pressed)
                    .map(|(_, v)| *v);
            }
        }
        "clear" => pressed = None,
        _ => return Err(format!("Unknown picker operation: {op}")),
    }
    if delta != 0 && !rows.is_empty() {
        let next = (cursor_index(&rows, cursor) + delta).clamp(0, rows.len() as isize - 1);
        cursor = Some(identity(rows[next as usize].1));
    }
    let index = cursor_index(&rows, cursor);
    let start = (index - 7).max(0) as usize;
    let window = rows.iter().skip(start).take(8);
    let selected = rows.get(index as usize).map(|(_, v)| v);
    Ok(json!({
        "state": {"cursor":cursor, "filter":filter, "pressed":pressed}, "replace":replace,
        "visible":window.clone().map(|(i,_)|i).collect::<Vec<_>>(),
        "highlighted":window.filter(|(_, v)| Some(v) == selected).map(|(i,_)|i).collect::<Vec<_>>(),
        "handled":handled,
        "close":close || choose.is_some(), "choice":choose
    }))
}
