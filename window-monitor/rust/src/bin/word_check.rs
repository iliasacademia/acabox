use serde::Serialize;
use std::collections::HashMap;
use window_monitor_lib::{accessibility, applescript, window_list, workspace};

#[derive(Serialize)]
struct CheckOutput {
    timestamp: String,
    word_running: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    windows: Vec<WindowInfo>,
}

#[derive(Serialize)]
struct WindowInfo {
    window_id: u32,
    title: Option<String>,
    document_path: Option<String>,
    has_unsaved_changes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    save_error: Option<String>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn decode_file_url(url: &str) -> String {
    let path = url
        .strip_prefix("file://localhost")
        .or_else(|| url.strip_prefix("file://"))
        .unwrap_or(url);

    let mut result = String::with_capacity(path.len());
    let mut chars = path.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next().and_then(|c| (c as char).to_digit(16));
            let lo = chars.next().and_then(|c| (c as char).to_digit(16));
            if let (Some(h), Some(l)) = (hi, lo) {
                result.push((h * 16 + l) as u8 as char);
            } else {
                result.push('%');
            }
        } else {
            result.push(b as char);
        }
    }
    result
}

/// Query all Word documents' saved status in one AppleScript call.
/// Returns a map of document name -> has_unsaved_changes.
fn get_all_docs_saved_status() -> HashMap<String, bool> {
    let script = r#"tell application "Microsoft Word"
    set docCount to count of documents
    set output to ""
    repeat with i from 1 to docCount
        set doc to document i
        set docName to name of doc
        set isSaved to saved of doc
        set output to output & docName & tab & isSaved & linefeed
    end repeat
    return output
end tell"#;

    let mut map = HashMap::new();
    match applescript::run_applescript(script) {
        Ok(output) => {
            for line in output.lines() {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    let doc_name = parts[0].to_string();
                    let has_unsaved = parts[1].trim() != "true";
                    map.insert(doc_name, has_unsaved);
                }
            }
        }
        Err(e) => {
            eprintln!("AppleScript error: {}", e);
        }
    }
    map
}

/// Save a Word document by name. Only safe to call when the name is unique.
fn save_document_by_name(doc_name: &str) -> Result<(), String> {
    let escaped = doc_name.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"tell application "Microsoft Word"
    save document "{}"
end tell"#,
        escaped
    );
    applescript::run_applescript(&script).map(|_| ())
}

fn check_word_windows() -> CheckOutput {
    let (pid, _name) = match workspace::find_running_app("com.microsoft.Word") {
        Some(v) => v,
        None => return CheckOutput { timestamp: now(), word_running: false, windows: vec![] },
    };

    let app_element = match accessibility::create_app_element(pid) {
        Some(el) => el,
        None => {
            eprintln!("Failed to create AX app element for Word (pid {})", pid);
            return CheckOutput { timestamp: now(), word_running: true, windows: vec![] };
        }
    };

    // Get window titles from CGWindowList
    let cg_windows = window_list::get_windows_for_pid(pid);
    let title_map: HashMap<u32, String> = cg_windows
        .into_iter()
        .filter_map(|w| w.name.map(|n| (w.window_id, n)))
        .collect();

    // Get saved status for all docs via single AppleScript call
    let saved_map = get_all_docs_saved_status();

    // Count how many times each doc name appears in AppleScript
    let mut name_counts: HashMap<String, usize> = HashMap::new();
    for name in saved_map.keys() {
        *name_counts.entry(name.clone()).or_default() += 1;
    }

    // Enumerate AX windows
    let ax_windows = accessibility::get_ax_windows(&app_element);
    let mut windows = Vec::new();

    // Count how many times each window title appears (for duplicate detection)
    let mut title_counts: HashMap<String, usize> = HashMap::new();
    for ax_win in &ax_windows {
        if accessibility::get_role(ax_win).as_deref() != Some("AXWindow") {
            continue;
        }
        if let Some(wid) = accessibility::get_window_id(ax_win) {
            if let Some(title) = title_map.get(&wid) {
                *title_counts.entry(title.clone()).or_default() += 1;
            }
        }
    }

    for ax_win in &ax_windows {
        if accessibility::get_role(ax_win).as_deref() != Some("AXWindow") {
            continue;
        }
        let window_id = match accessibility::get_window_id(ax_win) {
            Some(id) => id,
            None => continue,
        };

        let title = title_map.get(&window_id).cloned();
        let document_path = accessibility::get_document(ax_win).map(|u| decode_file_url(&u));

        // Match by window title vs doc name (strip extension)
        let has_unsaved_changes = title.as_ref().and_then(|t| {
            if let Some(&v) = saved_map.get(t) {
                return Some(v);
            }
            for (doc_name, &unsaved) in &saved_map {
                let stem = doc_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(doc_name);
                if t == stem || t.starts_with(stem) {
                    return Some(unsaved);
                }
            }
            None
        });

        // Check if this title is duplicated across windows
        let is_duplicate = title.as_ref()
            .map(|t| title_counts.get(t).copied().unwrap_or(0) > 1)
            .unwrap_or(false);

        let save_error = if has_unsaved_changes == Some(true) && is_duplicate {
            Some("Cannot save: multiple windows have the same name".to_string())
        } else {
            None
        };

        windows.push(WindowInfo {
            window_id,
            title,
            document_path,
            has_unsaved_changes,
            save_error,
        });
    }

    CheckOutput { timestamp: now(), word_running: true, windows }
}

fn main() {
    eprintln!("word-check: polling every 10 seconds. Press Ctrl+C to stop.");
    loop {
        let result = check_word_windows();
        println!("{}", serde_json::to_string_pretty(&result).unwrap());

        // Save unsaved docs (only those without save errors)
        let to_save: Vec<(&str, &str)> = result.windows.iter()
            .filter(|w| w.has_unsaved_changes == Some(true) && w.save_error.is_none())
            .filter_map(|w| {
                let title = w.title.as_deref()?;
                Some((title, w.document_path.as_deref().unwrap_or("unknown")))
            })
            .collect();

        if !to_save.is_empty() {
            eprintln!("Found {} saveable unsaved doc(s), saving in 5 seconds...", to_save.len());
            std::thread::sleep(std::time::Duration::from_secs(5));

            // Re-query to get current doc names
            let saved_map = get_all_docs_saved_status();
            for (title, path) in &to_save {
                // Find the AppleScript doc name matching this window title
                let doc_name = saved_map.keys()
                    .find(|dn| {
                        let stem = dn.rsplit_once('.').map(|(s, _)| s).unwrap_or(dn);
                        *title == stem || title.starts_with(stem) || *title == dn.as_str()
                    })
                    .cloned();

                if let Some(name) = doc_name {
                    match save_document_by_name(&name) {
                        Ok(_) => eprintln!("  Saved \"{}\" ({})", name, path),
                        Err(e) => eprintln!("  Failed to save \"{}\": {}", name, e),
                    }
                } else {
                    eprintln!("  Could not find AppleScript doc for title \"{}\"", title);
                }
            }
        }

        std::thread::sleep(std::time::Duration::from_secs(10));
    }
}
