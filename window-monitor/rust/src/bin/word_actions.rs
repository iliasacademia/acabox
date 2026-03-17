use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::NSString;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io;
use std::thread;
use std::time::Duration;
use window_monitor_lib::accessibility;

fn default_bundle_id() -> String {
    "com.microsoft.Word".to_string()
}

#[derive(Deserialize)]
struct Action {
    action: String,
    #[serde(default)]
    window_id: u32,
    #[serde(default = "default_bundle_id")]
    bundle_id: String,
    text: Option<String>,
    position: Option<i64>,
    length: Option<i64>,
    #[serde(default)]
    activate: bool,
    file_path: Option<String>,
    save: Option<bool>,
}

fn activate_app(bundle_id: &str) -> Result<(), String> {
    let workspace = NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();
    let bundle_ns = NSString::from_str(bundle_id);

    let count = apps.count();
    for i in 0..count {
        let app: objc2::rc::Retained<NSRunningApplication> = apps.objectAtIndex(i);
        if let Some(bid) = app.bundleIdentifier() {
            if bid.isEqualToString(&bundle_ns) {
                #[allow(deprecated)]
                let _ = app.activateWithOptions(
                    objc2_app_kit::NSApplicationActivationOptions::ActivateIgnoringOtherApps,
                );
                thread::sleep(Duration::from_millis(200));
                return Ok(());
            }
        }
    }

    Err(format!(
        "App with bundle ID '{}' not found running",
        bundle_id
    ))
}

/// Get PID for a running app by bundle ID.
fn get_pid_for_bundle(bundle_id: &str) -> Option<i32> {
    let workspace = NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();
    let bundle_ns = NSString::from_str(bundle_id);

    let count = apps.count();
    for i in 0..count {
        let app: objc2::rc::Retained<NSRunningApplication> = apps.objectAtIndex(i);
        if let Some(bid) = app.bundleIdentifier() {
            if bid.isEqualToString(&bundle_ns) {
                return Some(app.processIdentifier());
            }
        }
    }
    None
}

/// Activate the app and raise the specific window to bring it to the front.
/// Polls for focus confirmation after raising (10ms intervals, ~200ms timeout).
fn activate_and_raise_window(action: &Action) -> Result<(), String> {
    activate_app(&action.bundle_id)?;
    let pid = get_pid_for_bundle(&action.bundle_id)
        .ok_or("Could not find PID for app")?;
    let app_element = accessibility::create_app_element(pid)
        .ok_or("Failed to create AX app element")?;
    let ax_window = accessibility::find_ax_window_by_id(&app_element, action.window_id)
        .ok_or("Failed to find AX window by ID")?;
    accessibility::raise_window(&ax_window);

    // Poll until the target window is focused (10ms intervals, ~200ms timeout)
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(10));
        let focused_id = accessibility::get_focused_window(&app_element)
            .and_then(|w| accessibility::get_window_id(&w));
        if focused_id == Some(action.window_id) {
            return Ok(());
        }
    }

    // Return Ok even if focus wasn't confirmed — the focus check in
    // get_word_document_text will catch any actual mismatch.
    Ok(())
}

/// Ease-in-out cubic function for smooth scroll animation (slow-fast-slow).
fn ease_in_out(t: f64) -> f64 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

struct NormalizedText {
    text: String,
    /// For each byte index in `text`, the corresponding byte index in the original string.
    byte_map: Vec<usize>,
}

/// Normalize whitespace variants so that search matching is tolerant of Word's
/// Accessibility API returning `\r` instead of `\n`, NBSP instead of space, etc.
fn normalize_whitespace(input: &str) -> NormalizedText {
    let mut text = String::with_capacity(input.len());
    let mut byte_map: Vec<usize> = Vec::with_capacity(input.len());
    let mut chars = input.char_indices().peekable();

    while let Some((byte_idx, ch)) = chars.next() {
        match ch {
            '\r' => {
                // \r\n → \n  (consume the \n if present)
                // \r   → \n
                if chars.peek().map(|&(_, c)| c) == Some('\n') {
                    chars.next(); // skip the \n
                }
                text.push('\n');
                byte_map.push(byte_idx);
            }
            '\x0B' | '\x0C' | '\u{2028}' | '\u{2029}' => {
                // Vertical tab (soft line break), form feed (page break),
                // Unicode line/paragraph separator → \n
                text.push('\n');
                byte_map.push(byte_idx);
            }
            '\u{00A0}' | '\u{202F}' => {
                // Non-breaking space variants → regular space
                text.push(' ');
                byte_map.push(byte_idx);
            }
            '\u{00AD}' => {
                // Soft hyphen → removed entirely
            }
            _ => {
                let start = text.len();
                text.push(ch);
                // Map each new byte in `text` back to the corresponding original byte
                for i in 0..ch.len_utf8() {
                    byte_map.push(byte_idx + i);
                }
                debug_assert_eq!(byte_map.len(), text.len());
                let _ = start; // suppress unused warning
            }
        }
    }
    NormalizedText { text, byte_map }
}

/// Given a search text found at `string_char_pos` in the AXStringForRange output,
/// find the exact document-coordinate offset by scanning with AXStringForRange.
fn find_doc_offset_for_string_pos(
    text_area: &accessibility::SafeAXUIElement,
    search_text: &str,
    string_char_pos: usize,
    total_doc_chars: i64,
    total_string_chars: usize,
) -> Option<i64> {
    let estimate =
        (string_char_pos as f64 / total_string_chars as f64 * total_doc_chars as f64) as i64;

    let normalized_search = normalize_whitespace(search_text);
    let scan_radius = 50i64;
    let scan_start = (estimate - scan_radius).max(0);
    let scan_end = (estimate + scan_radius).min(total_doc_chars);
    let search_doc_len = (search_text.chars().count() as i64 + 5).min(total_doc_chars - scan_start);

    for d in scan_start..=scan_end {
        let chunk_len = search_doc_len.min(total_doc_chars - d);
        if chunk_len <= 0 {
            break;
        }
        if let Some(chunk) = accessibility::get_string_for_range(text_area, d, chunk_len) {
            let normalized_chunk = normalize_whitespace(&chunk);
            if normalized_chunk.text.starts_with(&normalized_search.text) {
                return Some(d);
            }
        }
    }
    None
}

/// Get text areas and total character count for a window.
fn get_text_areas(
    pid: i32,
    window_id: u32,
) -> Result<(Vec<accessibility::SafeAXUIElement>, i64), String> {
    let app_element = accessibility::create_app_element(pid)
        .ok_or("Failed to create AX app element")?;

    let ax_window = accessibility::find_ax_window_by_id(&app_element, window_id)
        .ok_or("Failed to find AX window by ID")?;

    let mut text_areas = accessibility::find_all_text_areas_in_subtree(&ax_window, 10);
    if text_areas.is_empty() {
        return Err("No text areas found in document".to_string());
    }

    // Find the text area with the most characters — index 0 is often a
    // header/footer element with only 1 char, not the document body.
    let mut best_idx = 0;
    let mut best_count: i64 = 0;
    for (i, ta) in text_areas.iter().enumerate() {
        let cc = accessibility::get_character_count(ta).unwrap_or(0);
        if cc > best_count {
            best_count = cc;
            best_idx = i;
        }
    }

    if best_count == 0 {
        return Err("Document appears empty".to_string());
    }

    // Move the best text area to index 0 so callers can use text_areas[0]
    text_areas.swap(0, best_idx);

    Ok((text_areas, best_count))
}

fn handle_scroll(action: &Action) -> Value {
    let position = match action.position {
        Some(p) => p,
        None => return json!({"success": false, "action": "scroll", "error": "Missing 'position' field"}),
    };

    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "scroll", "error": "Could not find PID for app"}),
    };

    let app_element = match accessibility::create_app_element(pid) {
        Some(e) => e,
        None => return json!({"success": false, "action": "scroll", "error": "Failed to create AX app element"}),
    };

    let ax_window = match accessibility::find_ax_window_by_id(&app_element, action.window_id) {
        Some(w) => w,
        None => return json!({"success": false, "action": "scroll", "error": "Failed to find AX window by ID"}),
    };

    let text_areas = accessibility::find_all_text_areas_in_subtree(&ax_window, 10);
    if text_areas.is_empty() {
        return json!({"success": false, "action": "scroll", "error": "No text areas found in document"});
    }

    let total_doc_chars = match accessibility::get_character_count(&text_areas[0]) {
        Some(c) => c,
        None => return json!({"success": false, "action": "scroll", "error": "Failed to get document character count"}),
    };

    let sel_length = action.length.unwrap_or(0);
    let sel_length_for_probe = if sel_length > 0 { sel_length } else { 1 };
    accessibility::set_selected_text_range(&text_areas[0], position, sel_length_for_probe);
    thread::sleep(Duration::from_millis(50));

    if let Some(scroll_bar) = accessibility::find_vertical_scroll_bar(&ax_window, 10) {
        let current_scroll = accessibility::get_scroll_bar_value(&scroll_bar).unwrap_or(0.0);

        let sel_range = accessibility::CFRange {
            location: position,
            length: sel_length_for_probe,
        };

        let target_scroll =
            if let Some(window_bounds) = accessibility::get_element_bounds(&ax_window) {
                let target_y = window_bounds.origin.y + window_bounds.size.height * 0.15;

                let probe_a = current_scroll;
                let y_a = accessibility::get_bounds_for_range(&text_areas[0], &sel_range)
                    .map(|b| b.origin.y);

                let probe_b = (current_scroll + 0.1).min(1.0);
                accessibility::set_scroll_bar_value(&scroll_bar, probe_b);
                thread::sleep(Duration::from_millis(30));
                let y_b = accessibility::get_bounds_for_range(&text_areas[0], &sel_range)
                    .map(|b| b.origin.y);

                accessibility::set_scroll_bar_value(&scroll_bar, current_scroll);
                thread::sleep(Duration::from_millis(30));

                if let (Some(y_a), Some(y_b)) = (y_a, y_b) {
                    let slope = (y_b - y_a) / (probe_b - probe_a);
                    if slope.abs() > 0.001 {
                        let target = probe_a + (target_y - y_a) / slope;
                        target.clamp(0.0, 1.0)
                    } else {
                        (position as f64 / total_doc_chars as f64).clamp(0.0, 1.0)
                    }
                } else {
                    (position as f64 / total_doc_chars as f64).clamp(0.0, 1.0)
                }
            } else {
                (position as f64 / total_doc_chars as f64).clamp(0.0, 1.0)
            };

        if (target_scroll - current_scroll).abs() > 0.01 {
            let steps = 15;
            for i in 1..=steps {
                let t = ease_in_out(i as f64 / steps as f64);
                let value = current_scroll + (target_scroll - current_scroll) * t;
                accessibility::set_scroll_bar_value(&scroll_bar, value);
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    json!({"success": true, "action": "scroll"})
}

fn handle_set_cursor(action: &Action) -> Value {
    let position = match action.position {
        Some(p) => p,
        None => return json!({"success": false, "action": "set_cursor", "error": "Missing 'position' field"}),
    };

    let length = action.length.unwrap_or(0);

    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "set_cursor", "error": "Could not find PID for app"}),
    };

    let (text_areas, _) = match get_text_areas(pid, action.window_id) {
        Ok(r) => r,
        Err(e) => return json!({"success": false, "action": "set_cursor", "error": e}),
    };

    let set_ok = accessibility::set_selected_text_range(&text_areas[0], position, length);
    if !set_ok {
        return json!({"success": false, "action": "set_cursor", "error": "Failed to set text selection"});
    }

    json!({"success": true, "action": "set_cursor"})
}

fn handle_read_document(action: &Action) -> Value {
    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "read_document", "error": "Could not find PID for app"}),
    };

    let app_element = match accessibility::create_app_element(pid) {
        Some(e) => e,
        None => return json!({"success": false, "action": "read_document", "error": "Failed to create AX app element"}),
    };

    let full_text = match window_monitor_lib::applescript::get_word_document_text(&app_element, action.window_id) {
        Ok(t) => t,
        Err(e) => return json!({"success": false, "action": "read_document", "error": format!("AppleScript failed: {}", e)}),
    };

    let char_count = full_text.chars().count() as i64;
    json!({"success": true, "action": "read_document", "text": full_text, "length": char_count})
}

fn handle_search_all(action: &Action) -> Value {
    let search_text = match &action.text {
        Some(t) => t,
        None => return json!({"success": false, "action": "search_all", "error": "Missing 'text' field"}),
    };

    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "search_all", "error": "Could not find PID for app"}),
    };

    let (text_areas, total_doc_chars) = match get_text_areas(pid, action.window_id) {
        Ok(r) => r,
        Err(e) => return json!({"success": false, "action": "search_all", "error": e}),
    };

    let full_text = match accessibility::get_string_for_range(&text_areas[0], 0, total_doc_chars) {
        Some(t) => t,
        None => return json!({"success": false, "action": "search_all", "error": "Failed to read document text"}),
    };

    let total_string_chars = full_text.chars().count();
    let context_chars = 30usize;

    // Normalize both texts for matching
    let norm_full = normalize_whitespace(&full_text);
    let norm_search = normalize_whitespace(search_text);
    let mut matches = Vec::new();
    let mut start = 0usize;
    let mut index = 0i64;

    while let Some(byte_pos) = norm_full.text[start..].find(norm_search.text.as_str()) {
        let norm_abs_byte_pos = start + byte_pos;
        let norm_match_end_byte = norm_abs_byte_pos + norm_search.text.len();

        // Map normalized byte positions back to original byte positions
        let orig_start_byte = norm_full.byte_map[norm_abs_byte_pos];
        // For end byte: use the byte_map entry for the last byte of the match,
        // then find the end of that character in the original string.
        let orig_end_byte = if norm_match_end_byte < norm_full.byte_map.len() {
            norm_full.byte_map[norm_match_end_byte]
        } else {
            full_text.len()
        };

        // Character positions in the original text
        let orig_char_pos = full_text[..orig_start_byte].chars().count();
        let orig_match_char_len = full_text[orig_start_byte..orig_end_byte].chars().count() as i64;

        // Get surrounding context from original text
        let ctx_start_char = orig_char_pos.saturating_sub(context_chars);
        let ctx_end_char = (orig_char_pos + orig_match_char_len as usize + context_chars).min(total_string_chars);

        let ctx_start_byte = full_text.char_indices().nth(ctx_start_char).map(|(i, _)| i).unwrap_or(0);
        let ctx_end_byte = full_text.char_indices().nth(ctx_end_char).map(|(i, _)| i).unwrap_or(full_text.len());
        let context = &full_text[ctx_start_byte..ctx_end_byte];

        // Map string position to document offset (use original char pos for estimation)
        let position = find_doc_offset_for_string_pos(
            &text_areas[0],
            search_text,
            orig_char_pos,
            total_doc_chars,
            total_string_chars,
        );

        if let Some(pos) = position {
            matches.push(json!({
                "index": index,
                "position": pos,
                "length": orig_match_char_len,
                "context": context,
            }));
        }

        index += 1;
        start = norm_abs_byte_pos + norm_search.text.len();
    }

    json!({"success": true, "action": "search_all", "matches": matches, "total_matches": matches.len()})
}

fn handle_has_unsaved_changes(action: &Action) -> Value {
    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "has_unsaved_changes", "error": "Could not find PID for app"}),
    };

    let app_element = match accessibility::create_app_element(pid) {
        Some(e) => e,
        None => return json!({"success": false, "action": "has_unsaved_changes", "error": "Failed to create AX app element"}),
    };

    match window_monitor_lib::applescript::has_word_document_unsaved_changes(&app_element, action.window_id) {
        Ok(unsaved) => json!({"success": true, "action": "has_unsaved_changes", "unsaved_changes": unsaved}),
        Err(e) => json!({"success": false, "action": "has_unsaved_changes", "error": e}),
    }
}

fn handle_save_document(action: &Action) -> Value {
    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "save_document", "error": "Could not find PID for app"}),
    };

    let app_element = match accessibility::create_app_element(pid) {
        Some(e) => e,
        None => return json!({"success": false, "action": "save_document", "error": "Failed to create AX app element"}),
    };

    match window_monitor_lib::applescript::save_word_document(&app_element, action.window_id) {
        Ok(()) => json!({"success": true, "action": "save_document"}),
        Err(e) => json!({"success": false, "action": "save_document", "error": e}),
    }
}

fn handle_close_window(action: &Action) -> Value {
    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "close_window", "error": "Could not find PID for app"}),
    };

    let app_element = match accessibility::create_app_element(pid) {
        Some(e) => e,
        None => return json!({"success": false, "action": "close_window", "error": "Failed to create AX app element"}),
    };

    let save = action.save.unwrap_or(false);
    match window_monitor_lib::applescript::close_word_document(&app_element, action.window_id, save) {
        Ok(()) => json!({"success": true, "action": "close_window"}),
        Err(e) => json!({"success": false, "action": "close_window", "error": e}),
    }
}

fn handle_open_window(action: &Action) -> Value {
    let file_path = match &action.file_path {
        Some(p) => p,
        None => return json!({"success": false, "action": "open_window", "error": "Missing 'file_path' field"}),
    };

    match window_monitor_lib::applescript::open_word_document(file_path) {
        Ok(()) => json!({"success": true, "action": "open_window"}),
        Err(e) => json!({"success": false, "action": "open_window", "error": e}),
    }
}

fn dispatch(action: &Action) -> Value {
    if action.activate {
        if let Err(e) = activate_and_raise_window(action) {
            return json!({"success": false, "action": action.action, "error": e});
        }
    }

    match action.action.as_str() {
        "search_all" => handle_search_all(action),
        "scroll" => handle_scroll(action),
        "set_cursor" => handle_set_cursor(action),
        "read_document" => handle_read_document(action),
        "has_unsaved_changes" => handle_has_unsaved_changes(action),
        "save_document" => handle_save_document(action),
        "close_window" => handle_close_window(action),
        "open_window" => handle_open_window(action),
        _ => json!({"success": false, "error": format!("Unknown action: {}", action.action)}),
    }
}

fn run_one(json_str: &str) {
    let response = match serde_json::from_str::<Action>(json_str) {
        Ok(action) => dispatch(&action),
        Err(e) => json!({"success": false, "error": format!("Invalid JSON: {}", e)}),
    };
    println!("{}", response);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() >= 3 && args[1] == "--json" {
        run_one(&args[2]);
    } else if args.len() >= 2 && args[1] == "--json" {
        let mut line = String::new();
        if io::stdin().read_line(&mut line).is_ok() && !line.trim().is_empty() {
            run_one(line.trim());
        } else {
            println!("{}", json!({"success": false, "error": "No JSON input provided"}));
        }
    } else {
        eprintln!("Usage: word-actions --json '<json>'");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_cr_to_lf() {
        let result = normalize_whitespace("hello\rworld");
        assert_eq!(result.text, "hello\nworld");
    }

    #[test]
    fn test_normalize_crlf_to_lf() {
        let result = normalize_whitespace("hello\r\nworld");
        assert_eq!(result.text, "hello\nworld");
        // "hello" is 5 bytes, \r is at byte 5, \n is at byte 6, "world" starts at byte 7
        // In normalized: "hello\nworld" — the \n at byte 5 maps to original byte 5 (\r)
        assert_eq!(result.byte_map[5], 5); // \n maps to \r position
        // 'w' in normalized is at byte 6, in original at byte 7
        assert_eq!(result.byte_map[6], 7);
    }

    #[test]
    fn test_normalize_nbsp_to_space() {
        let result = normalize_whitespace("hello\u{00A0}world");
        assert_eq!(result.text, "hello world");
        // Space at byte 5 maps to original byte 5 (start of \u{00A0} which is 2 bytes)
        assert_eq!(result.byte_map[5], 5);
        // 'w' in normalized is at byte 6, in original at byte 7 (\u{00A0} is 2 bytes)
        assert_eq!(result.byte_map[6], 7);
    }

    #[test]
    fn test_normalize_narrow_nbsp_to_space() {
        let result = normalize_whitespace("a\u{202F}b");
        assert_eq!(result.text, "a b");
    }

    #[test]
    fn test_normalize_unicode_line_separators() {
        let result = normalize_whitespace("a\u{2028}b\u{2029}c");
        assert_eq!(result.text, "a\nb\nc");
    }

    #[test]
    fn test_normalize_soft_hyphen_removed() {
        let result = normalize_whitespace("hel\u{00AD}lo");
        assert_eq!(result.text, "hello");
        assert_eq!(result.byte_map.len(), result.text.len());
    }

    #[test]
    fn test_normalize_identity() {
        let input = "hello world\n";
        let result = normalize_whitespace(input);
        assert_eq!(result.text, input);
        // byte_map should be identity
        for (i, &mapped) in result.byte_map.iter().enumerate() {
            assert_eq!(i, mapped);
        }
    }

    #[test]
    fn test_normalize_byte_map_multibyte() {
        // Test with a multi-byte char that is NOT normalized (e.g. é = 2 bytes in UTF-8)
        let input = "café";
        let result = normalize_whitespace(input);
        assert_eq!(result.text, "café");
        assert_eq!(result.byte_map.len(), result.text.len());
        // 'c' at 0, 'a' at 1, 'f' at 2, 'é' at bytes 3-4
        assert_eq!(result.byte_map[0], 0);
        assert_eq!(result.byte_map[1], 1);
        assert_eq!(result.byte_map[2], 2);
        assert_eq!(result.byte_map[3], 3);
        assert_eq!(result.byte_map[4], 4);
    }

    #[test]
    fn test_normalize_mixed() {
        let input = "a\r\nb\u{00A0}c\u{00AD}d\re";
        let result = normalize_whitespace(input);
        // \r\n → \n, \u{00A0} → space, \u{00AD} → removed, \r → \n
        assert_eq!(result.text, "a\nb cd\ne");
        assert_eq!(result.byte_map.len(), result.text.len());
    }

    #[test]
    fn test_normalize_vertical_tab_to_lf() {
        let result = normalize_whitespace("hello\x0Bworld");
        assert_eq!(result.text, "hello\nworld");
        assert_eq!(result.byte_map[5], 5); // \x0B is 1 byte, maps 1:1
        assert_eq!(result.byte_map[6], 6);
    }

    #[test]
    fn test_normalize_form_feed_to_lf() {
        let result = normalize_whitespace("hello\x0Cworld");
        assert_eq!(result.text, "hello\nworld");
        assert_eq!(result.byte_map[5], 5);
        assert_eq!(result.byte_map[6], 6);
    }

    #[test]
    fn test_normalize_mixed_with_vt_ff() {
        let input = "a\x0Bb\x0Cc\r\nd\u{00A0}e";
        let result = normalize_whitespace(input);
        // \x0B → \n, \x0C → \n, \r\n → \n, \u{00A0} → space
        assert_eq!(result.text, "a\nb\nc\nd e");
        assert_eq!(result.byte_map.len(), result.text.len());
    }

    #[test]
    fn test_normalize_empty() {
        let result = normalize_whitespace("");
        assert_eq!(result.text, "");
        assert!(result.byte_map.is_empty());
    }
}
