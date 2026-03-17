use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::NSString;
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::c_void;
use std::io::{self, BufRead, Write};
use std::thread;
use std::time::Duration;
use window_monitor_lib::accessibility;

// CGEvent FFI
type CGEventRef = *mut c_void;

#[allow(non_upper_case_globals)]
const kCGHIDEventTap: u32 = 0;

extern "C" {
    fn CGEventCreateKeyboardEvent(
        source: *const c_void,
        virtual_key: u16,
        key_down: bool,
    ) -> CGEventRef;
    fn CGEventKeyboardSetUnicodeString(
        event: CGEventRef,
        string_length: u64,
        unicode_string: *const u16,
    );
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CFRelease(cf: *const c_void);
}

fn default_bundle_id() -> String {
    "com.microsoft.Word".to_string()
}

#[derive(Deserialize)]
struct Action {
    action: String,
    window_id: u32,
    #[serde(default = "default_bundle_id")]
    bundle_id: String,
    text: Option<String>,
    color: Option<String>,
    position: Option<i64>,
    length: Option<i64>,
    find_text: Option<String>,
    replace_text: Option<String>,
    occurrence_index: Option<i64>,
}

fn parse_hex_color(s: &str) -> Result<(u8, u8, u8), String> {
    let s = s.strip_prefix('#').unwrap_or(s);
    if s.len() != 6 {
        return Err(format!("Expected 6 hex digits, got '{}'", s));
    }
    let r = u8::from_str_radix(&s[0..2], 16).map_err(|e| e.to_string())?;
    let g = u8::from_str_radix(&s[2..4], 16).map_err(|e| e.to_string())?;
    let b = u8::from_str_radix(&s[4..6], 16).map_err(|e| e.to_string())?;
    Ok((r, g, b))
}

/// Type a string character by character with a typewriter effect.
fn type_text(text: &str) {
    for ch in text.chars() {
        let utf16: Vec<u16> = ch.encode_utf16(&mut [0u16; 2]).to_vec();

        unsafe {
            let key_down = CGEventCreateKeyboardEvent(std::ptr::null(), 0, true);
            let key_up = CGEventCreateKeyboardEvent(std::ptr::null(), 0, false);

            if key_down.is_null() || key_up.is_null() {
                eprintln!("Failed to create CGEvent");
                return;
            }

            CGEventKeyboardSetUnicodeString(key_down, utf16.len() as u64, utf16.as_ptr());
            CGEventKeyboardSetUnicodeString(key_up, utf16.len() as u64, utf16.as_ptr());

            CGEventPost(kCGHIDEventTap, key_down);
            CGEventPost(kCGHIDEventTap, key_up);

            CFRelease(key_down as *const c_void);
            CFRelease(key_up as *const c_void);
        }

        thread::sleep(Duration::from_millis(30));
    }
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
fn activate_and_raise_window(action: &Action) -> Result<(), String> {
    activate_app(&action.bundle_id)?;
    let pid = get_pid_for_bundle(&action.bundle_id)
        .ok_or("Could not find PID for app")?;
    let app_element = accessibility::create_app_element(pid)
        .ok_or("Failed to create AX app element")?;
    let ax_window = accessibility::find_ax_window_by_id(&app_element, action.window_id)
        .ok_or("Failed to find AX window by ID")?;
    accessibility::raise_window(&ax_window);
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
            if chunk.starts_with(search_text) {
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

/// Run an AppleScript string inline via NSAppleScript (no subprocess).
fn run_applescript(source: &str) -> Result<String, String> {
    use objc2::runtime::AnyObject;

    unsafe {
        let cls = objc2::class!(NSAppleScript);
        let source_ns = NSString::from_str(source);
        let script: *mut AnyObject = objc2::msg_send![cls, alloc];
        let script: *mut AnyObject = objc2::msg_send![script, initWithSource: &*source_ns];
        if script.is_null() {
            return Err("Failed to create NSAppleScript".to_string());
        }

        let mut error: *mut AnyObject = std::ptr::null_mut();
        let result: *mut AnyObject = objc2::msg_send![
            script,
            executeAndReturnError: &mut error
        ];

        let _: () = objc2::msg_send![script, release];

        if !error.is_null() {
            let desc: *mut AnyObject = objc2::msg_send![error, description];
            if !desc.is_null() {
                let utf8: *const u8 = objc2::msg_send![desc, UTF8String];
                if !utf8.is_null() {
                    let s = std::ffi::CStr::from_ptr(utf8 as *const _).to_string_lossy().into_owned();
                    return Err(s);
                }
            }
            return Err("AppleScript execution failed".to_string());
        }

        if result.is_null() {
            return Ok(String::new());
        }

        let string_val: *mut AnyObject = objc2::msg_send![result, stringValue];
        if string_val.is_null() {
            return Ok(String::new());
        }
        let utf8: *const u8 = objc2::msg_send![string_val, UTF8String];
        if utf8.is_null() {
            return Ok(String::new());
        }
        Ok(std::ffi::CStr::from_ptr(utf8 as *const _).to_string_lossy().into_owned())
    }
}

/// Ensure track changes (track revisions) is enabled on the active Word document.
/// This should be called before any document mutation so edits appear as tracked revisions.
fn ensure_track_changes() -> Result<(), String> {
    let state = run_applescript(
        "tell application \"Microsoft Word\" to get track revisions of active document",
    )?;
    if state.trim().to_lowercase() != "true" {
        run_applescript(
            "tell application \"Microsoft Word\" to set track revisions of active document to true",
        )?;
    }
    Ok(())
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

/// Insert text at the current cursor position by typing it via CGEvents,
/// then optionally color it using AppleScript.
fn handle_insert_text(action: &Action) -> Value {
    let text = match &action.text {
        Some(t) => t,
        None => return json!({"success": false, "action": "insert_text", "error": "Missing 'text' field"}),
    };

    if let Err(e) = ensure_track_changes() {
        return json!({"success": false, "action": "insert_text", "error": format!("Failed to enable track changes: {}", e)});
    }

    if let Err(e) = activate_app(&action.bundle_id) {
        return json!({"success": false, "action": "insert_text", "error": e});
    }

    // If position provided, set cursor there first
    if let Some(position) = action.position {
        let pid = match get_pid_for_bundle(&action.bundle_id) {
            Some(pid) => pid,
            None => return json!({"success": false, "action": "insert_text", "error": "Could not find PID for app"}),
        };
        let (text_areas, _) = match get_text_areas(pid, action.window_id) {
            Ok(r) => r,
            Err(e) => return json!({"success": false, "action": "insert_text", "error": e}),
        };
        accessibility::set_selected_text_range(&text_areas[0], position, 0);
        thread::sleep(Duration::from_millis(50));
    }

    // Remember cursor position before typing (for coloring the typed text after)
    let pre_position = if action.color.is_some() {
        let pid = get_pid_for_bundle(&action.bundle_id);
        pid.and_then(|pid| {
            let (text_areas, total_doc_chars) = get_text_areas(pid, action.window_id).ok()?;
            let sel = accessibility::get_selected_text_range(&text_areas[0])?;
            if sel.location < total_doc_chars { Some(sel.location) } else { None }
        })
    } else {
        None
    };

    // Type the text
    type_text(text);

    // If color specified, wait for Word to process the keystrokes, then color the typed text
    if let Some(color_str) = &action.color {
        let (r, g, b) = match parse_hex_color(color_str) {
            Ok(c) => c,
            Err(e) => return json!({"success": false, "action": "insert_text", "error": format!("Invalid color: {}", e)}),
        };

        // Wait for keystrokes to be processed
        thread::sleep(Duration::from_millis(200));

        // Select the just-typed text
        let typed_len = text.chars().count() as i64;
        if let Some(start_pos) = pre_position {
            let pid = match get_pid_for_bundle(&action.bundle_id) {
                Some(pid) => pid,
                None => return json!({"success": true, "action": "insert_text"}),
            };
            if let Ok((text_areas, _)) = get_text_areas(pid, action.window_id) {
                accessibility::set_selected_text_range(&text_areas[0], start_pos, typed_len);
                thread::sleep(Duration::from_millis(50));
            }
        }

        // Color it
        let r16 = r as u32 * 257;
        let g16 = g as u32 * 257;
        let b16 = b as u32 * 257;
        let script = format!(
            "tell application \"Microsoft Word\" to set color of font object of selection to {{{}, {}, {}}}",
            r16, g16, b16
        );
        let _ = run_applescript(&script);

        // Move cursor to end of inserted text
        if let Some(start_pos) = pre_position {
            let pid = get_pid_for_bundle(&action.bundle_id);
            if let Some(pid) = pid {
                if let Ok((text_areas, _)) = get_text_areas(pid, action.window_id) {
                    accessibility::set_selected_text_range(&text_areas[0], start_pos + typed_len, 0);
                }
            }
        }
    }

    json!({"success": true, "action": "insert_text"})
}

/// Delete text character by character with a reverse typewriter effect.
/// Positions cursor at position + length, then sends backspace for each character.
fn handle_delete_text(action: &Action) -> Value {
    let position = match action.position {
        Some(p) => p,
        None => return json!({"success": false, "action": "delete_text", "error": "Missing 'position' field"}),
    };

    if let Err(e) = ensure_track_changes() {
        return json!({"success": false, "action": "delete_text", "error": format!("Failed to enable track changes: {}", e)});
    }

    let length = match action.length {
        Some(l) if l > 0 => l,
        _ => return json!({"success": false, "action": "delete_text", "error": "Missing or invalid 'length' field (must be > 0)"}),
    };

    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "delete_text", "error": "Could not find PID for app"}),
    };

    let (text_areas, _) = match get_text_areas(pid, action.window_id) {
        Ok(r) => r,
        Err(e) => return json!({"success": false, "action": "delete_text", "error": e}),
    };

    if let Err(e) = activate_app(&action.bundle_id) {
        return json!({"success": false, "action": "delete_text", "error": e});
    }

    // Place cursor at end of the range to delete
    accessibility::set_selected_text_range(&text_areas[0], position + length, 0);
    thread::sleep(Duration::from_millis(50));

    // Delete character by character using backspace (keycode 51)
    for _ in 0..length {
        unsafe {
            let key_down = CGEventCreateKeyboardEvent(std::ptr::null(), 51, true);
            let key_up = CGEventCreateKeyboardEvent(std::ptr::null(), 51, false);

            if key_down.is_null() || key_up.is_null() {
                return json!({"success": false, "action": "delete_text", "error": "Failed to create CGEvent"});
            }

            CGEventPost(kCGHIDEventTap, key_down);
            CGEventPost(kCGHIDEventTap, key_up);

            CFRelease(key_down as *const c_void);
            CFRelease(key_up as *const c_void);
        }

        thread::sleep(Duration::from_millis(30));
    }

    json!({"success": true, "action": "delete_text"})
}

fn handle_set_color(action: &Action) -> Value {
    let color_str = match &action.color {
        Some(c) => c,
        None => return json!({"success": false, "action": "set_color", "error": "Missing 'color' field"}),
    };

    if let Err(e) = ensure_track_changes() {
        return json!({"success": false, "action": "set_color", "error": format!("Failed to enable track changes: {}", e)});
    }

    let (r, g, b) = match parse_hex_color(color_str) {
        Ok(c) => c,
        Err(e) => return json!({"success": false, "action": "set_color", "error": format!("Invalid color: {}", e)}),
    };

    if let Err(e) = activate_app(&action.bundle_id) {
        return json!({"success": false, "action": "set_color", "error": e});
    }

    // If position/length provided, select the range first
    if let Some(position) = action.position {
        let length = action.length.unwrap_or(0);
        let pid = match get_pid_for_bundle(&action.bundle_id) {
            Some(pid) => pid,
            None => return json!({"success": false, "action": "set_color", "error": "Could not find PID for app"}),
        };
        let (text_areas, _) = match get_text_areas(pid, action.window_id) {
            Ok(r) => r,
            Err(e) => return json!({"success": false, "action": "set_color", "error": e}),
        };
        if !accessibility::set_selected_text_range(&text_areas[0], position, length) {
            return json!({"success": false, "action": "set_color", "error": "Failed to set text selection"});
        }
        thread::sleep(Duration::from_millis(50));
    }

    let r16 = r as u32 * 257;
    let g16 = g as u32 * 257;
    let b16 = b as u32 * 257;
    let script = format!(
        "tell application \"Microsoft Word\" to set color of font object of selection to {{{}, {}, {}}}",
        r16, g16, b16
    );

    match run_applescript(&script) {
        Ok(_) => json!({"success": true, "action": "set_color"}),
        Err(e) => json!({"success": false, "action": "set_color", "error": e}),
    }
}

fn handle_read_document(action: &Action) -> Value {
    if let Err(e) = activate_and_raise_window(action) {
        return json!({"success": false, "action": "read_document", "error": e});
    }

    let pid = match get_pid_for_bundle(&action.bundle_id) {
        Some(pid) => pid,
        None => return json!({"success": false, "action": "read_document", "error": "Could not find PID for app"}),
    };

    let (text_areas, total_doc_chars) = match get_text_areas(pid, action.window_id) {
        Ok(r) => r,
        Err(e) => return json!({"success": false, "action": "read_document", "error": e}),
    };

    let full_text = match accessibility::get_string_for_range(&text_areas[0], 0, total_doc_chars) {
        Some(t) => t,
        None => return json!({"success": false, "action": "read_document", "error": "Failed to read document text"}),
    };

    json!({"success": true, "action": "read_document", "text": full_text, "length": total_doc_chars})
}

fn handle_search_all(action: &Action) -> Value {
    let search_text = match &action.text {
        Some(t) => t,
        None => return json!({"success": false, "action": "search_all", "error": "Missing 'text' field"}),
    };

    if let Err(e) = activate_and_raise_window(action) {
        return json!({"success": false, "action": "search_all", "error": e});
    }

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
    let search_len = search_text.chars().count() as i64;
    let context_chars = 30usize;

    let mut matches = Vec::new();
    let mut start = 0usize;
    let mut index = 0i64;

    while let Some(byte_pos) = full_text[start..].find(search_text.as_str()) {
        let abs_byte_pos = start + byte_pos;
        let string_char_pos = full_text[..abs_byte_pos].chars().count();

        // Get surrounding context
        let ctx_start_char = string_char_pos.saturating_sub(context_chars);
        let ctx_end_char = (string_char_pos + search_text.chars().count() + context_chars).min(total_string_chars);

        let ctx_start_byte = full_text.char_indices().nth(ctx_start_char).map(|(i, _)| i).unwrap_or(0);
        let ctx_end_byte = full_text.char_indices().nth(ctx_end_char).map(|(i, _)| i).unwrap_or(full_text.len());
        let context = &full_text[ctx_start_byte..ctx_end_byte];

        // Map string position to document offset
        let position = find_doc_offset_for_string_pos(
            &text_areas[0],
            search_text,
            string_char_pos,
            total_doc_chars,
            total_string_chars,
        );

        if let Some(pos) = position {
            matches.push(json!({
                "index": index,
                "position": pos,
                "length": search_len,
                "context": context,
            }));
        }

        index += 1;
        start = abs_byte_pos + search_text.len();
    }

    json!({"success": true, "action": "search_all", "matches": matches, "total_matches": matches.len()})
}

fn handle_replace_text(action: &Action) -> Value {
    let find_text = match &action.find_text {
        Some(t) => t.clone(),
        None => return json!({"success": false, "action": "replace_text", "error": "Missing 'find_text' field"}),
    };
    let replace_text = match &action.replace_text {
        Some(t) => t.clone(),
        None => return json!({"success": false, "action": "replace_text", "error": "Missing 'replace_text' field"}),
    };

    if let Err(e) = ensure_track_changes() {
        return json!({"success": false, "action": "replace_text", "error": format!("Failed to enable track changes: {}", e)});
    }

    let occurrence_index = action.occurrence_index.unwrap_or(0);

    // First, search for all occurrences
    let search_action = Action {
        action: "search_all".to_string(),
        window_id: action.window_id,
        bundle_id: action.bundle_id.clone(),
        text: Some(find_text.clone()),
        color: None,
        position: None,
        length: None,
        find_text: None,
        replace_text: None,
        occurrence_index: None,
    };
    let search_result = handle_search_all(&search_action);

    if search_result["success"] != true {
        return json!({"success": false, "action": "replace_text", "error": search_result["error"]});
    }

    let matches = match search_result["matches"].as_array() {
        Some(m) => m.clone(),
        None => return json!({"success": false, "action": "replace_text", "error": "No matches found"}),
    };

    if matches.is_empty() {
        return json!({"success": false, "action": "replace_text", "error": format!("Text '{}' not found in document", find_text)});
    }

    // Determine which occurrences to replace
    let indices_to_replace: Vec<usize> = if occurrence_index == -1 {
        // Replace all — process in reverse order so positions don't shift
        (0..matches.len()).rev().collect()
    } else {
        let idx = occurrence_index as usize;
        if idx >= matches.len() {
            return json!({"success": false, "action": "replace_text", "error": format!("Occurrence index {} out of range (found {} matches)", occurrence_index, matches.len())});
        }
        vec![idx]
    };

    let mut replaced_count = 0;

    for idx in indices_to_replace {
        let m = &matches[idx];
        let pos = m["position"].as_i64().unwrap();
        let len = m["length"].as_i64().unwrap();

        // Delete the found text
        let delete_action = Action {
            action: "delete_text".to_string(),
            window_id: action.window_id,
            bundle_id: action.bundle_id.clone(),
            text: None,
            color: None,
            position: Some(pos),
            length: Some(len),
            find_text: None,
            replace_text: None,
            occurrence_index: None,
        };
        let delete_result = handle_delete_text(&delete_action);
        if delete_result["success"] != true {
            return json!({"success": false, "action": "replace_text", "error": format!("Failed to delete occurrence {}: {}", idx, delete_result["error"])});
        }

        // Insert the replacement text
        let insert_action = Action {
            action: "insert_text".to_string(),
            window_id: action.window_id,
            bundle_id: action.bundle_id.clone(),
            text: Some(replace_text.clone()),
            color: action.color.clone(),
            position: Some(pos),
            length: None,
            find_text: None,
            replace_text: None,
            occurrence_index: None,
        };
        let insert_result = handle_insert_text(&insert_action);
        if insert_result["success"] != true {
            return json!({"success": false, "action": "replace_text", "error": format!("Failed to insert replacement at occurrence {}: {}", idx, insert_result["error"])});
        }

        replaced_count += 1;
    }

    json!({"success": true, "action": "replace_text", "replaced_count": replaced_count})
}

fn dispatch(action: &Action) -> Value {
    match action.action.as_str() {
        "search_all" => handle_search_all(action),
        "scroll" => handle_scroll(action),
        "set_cursor" => handle_set_cursor(action),
        "insert_text" => handle_insert_text(action),
        "delete_text" => handle_delete_text(action),
        "replace_text" => handle_replace_text(action),
        "set_color" => handle_set_color(action),
        "read_document" => handle_read_document(action),
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

fn run_streaming() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<Action>(&line) {
            Ok(action) => dispatch(&action),
            Err(e) => json!({"success": false, "error": format!("Invalid JSON: {}", e)}),
        };

        writeln!(stdout, "{}", response).ok();
        stdout.flush().ok();
    }
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
        run_streaming();
    }
}
