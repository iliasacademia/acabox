use crate::accessibility::{self, SafeAXUIElement};
use objc2::runtime::AnyObject;
use objc2_foundation::NSString;

/// Run an AppleScript string inline via NSAppleScript (no subprocess).
pub fn run_applescript(source: &str) -> Result<String, String> {
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
                    let s = std::ffi::CStr::from_ptr(utf8 as *const _)
                        .to_string_lossy()
                        .into_owned();
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
        Ok(std::ffi::CStr::from_ptr(utf8 as *const _)
            .to_string_lossy()
            .into_owned())
    }
}

/// Get the full document text from Microsoft Word via AppleScript.
/// Validates that the target window is focused before reading the active document,
/// since Word's AppleScript `window id` returns `missing value` and cannot target
/// a specific window by CGWindowID.
/// Returns the document content with `\r` converted to `\n`.
pub fn get_word_document_text(app_element: &SafeAXUIElement, window_id: u32) -> Result<String, String> {
    // Validate that the focused window matches the target window_id
    let focused = accessibility::get_focused_window(app_element)
        .and_then(|w| accessibility::get_window_id(&w));
    if focused != Some(window_id) {
        eprintln!(
            "get_word_document_text: target window {} is not focused (focused: {:?})",
            window_id, focused
        );
        return Err("Target window is not focused".to_string());
    }

    let script = "tell application \"Microsoft Word\" to get content of text object of active document";
    let text = run_applescript(script)?;
    Ok(text.replace('\r', "\n"))
}

/// Check if the active Word document has unsaved changes.
/// Word's `saved` property is true when there are NO unsaved changes,
/// so we invert it: `saved == true` → `false` (no unsaved changes).
pub fn has_word_document_unsaved_changes(app_element: &SafeAXUIElement, window_id: u32) -> Result<bool, String> {
    let focused = accessibility::get_focused_window(app_element)
        .and_then(|w| accessibility::get_window_id(&w));
    if focused != Some(window_id) {
        eprintln!(
            "has_word_document_unsaved_changes: target window {} is not focused (focused: {:?})",
            window_id, focused
        );
        return Err("Target window is not focused".to_string());
    }

    let script = "tell application \"Microsoft Word\" to get (saved of active document) as string";
    let result = run_applescript(script)?;
    // Word's "saved" property: "true" means no unsaved changes
    Ok(result.trim() != "true")
}

/// Save the active Word document.
pub fn save_word_document(app_element: &SafeAXUIElement, window_id: u32) -> Result<(), String> {
    let focused = accessibility::get_focused_window(app_element)
        .and_then(|w| accessibility::get_window_id(&w));
    if focused != Some(window_id) {
        eprintln!(
            "save_word_document: target window {} is not focused (focused: {:?})",
            window_id, focused
        );
        return Err("Target window is not focused".to_string());
    }

    let script = "tell application \"Microsoft Word\" to save active document";
    run_applescript(script)?;
    Ok(())
}

/// Close the active Word document.
/// If `save` is true, saves before closing; otherwise closes without saving.
pub fn close_word_document(app_element: &SafeAXUIElement, window_id: u32, save: bool) -> Result<(), String> {
    let focused = accessibility::get_focused_window(app_element)
        .and_then(|w| accessibility::get_window_id(&w));
    if focused != Some(window_id) {
        eprintln!(
            "close_word_document: target window {} is not focused (focused: {:?})",
            window_id, focused
        );
        return Err("Target window is not focused".to_string());
    }

    let saving = if save { "yes" } else { "no" };
    let script = format!(
        "tell application \"Microsoft Word\" to close active document saving {}",
        saving
    );
    run_applescript(&script)?;
    Ok(())
}

/// Open a file in Microsoft Word and activate it.
pub fn open_word_document(file_path: &str) -> Result<(), String> {
    // Validate the file path to prevent AppleScript injection
    if file_path.contains('\0') {
        return Err("File path must not contain null bytes".to_string());
    }
    if file_path.contains('\n') || file_path.contains('\r') {
        return Err("File path must not contain newlines".to_string());
    }
    if !file_path.starts_with('/') {
        return Err("File path must be an absolute path starting with /".to_string());
    }
    if file_path.contains("/../") || file_path.ends_with("/..") {
        return Err("File path must not contain path traversal (/..)".to_string());
    }
    let lower = file_path.to_lowercase();
    if !lower.ends_with(".docx") && !lower.ends_with(".doc") {
        return Err("File path must have a .doc or .docx extension".to_string());
    }

    // Defense-in-depth: escape quotes and backslashes for AppleScript string embedding
    let escaped = file_path.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Microsoft Word\"\nopen \"{}\"\nactivate\nend tell",
        escaped
    );
    run_applescript(&script)?;
    Ok(())
}
