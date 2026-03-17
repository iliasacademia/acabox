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
/// Returns the document content with `\r` converted to `\n`.
pub fn get_word_document_text() -> Result<String, String> {
    let text = run_applescript(
        "tell application \"Microsoft Word\" to get content of text object of active document",
    )?;
    Ok(text.replace('\r', "\n"))
}
