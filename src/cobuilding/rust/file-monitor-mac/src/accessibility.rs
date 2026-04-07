use core_foundation::base::TCFType;
use core_foundation::runloop::CFRunLoopSource;
use core_foundation::string::CFString;
use std::ffi::c_void;
use std::ptr;
use std::sync::LazyLock;

// --- Raw FFI bindings for Accessibility API ---

pub type AXUIElementRef = *mut c_void;
pub type AXObserverRef = *mut c_void;
pub type AXError = i32;

pub const K_AX_ERROR_SUCCESS: AXError = 0;

/// Callback signature for AXObserver.
pub type AXObserverCallback = unsafe extern "C" fn(
    observer: AXObserverRef,
    element: AXUIElementRef,
    notification: core_foundation_sys::string::CFStringRef,
    context: *mut c_void,
);

extern "C" {
    pub fn AXIsProcessTrusted() -> bool;
    pub fn AXIsProcessTrustedWithOptions(
        options: core_foundation_sys::dictionary::CFDictionaryRef,
    ) -> bool;

    pub fn AXUIElementCreateApplication(pid: libc::pid_t) -> AXUIElementRef;

    pub fn AXObserverCreate(
        application: libc::pid_t,
        callback: AXObserverCallback,
        out_observer: *mut AXObserverRef,
    ) -> AXError;

    pub fn AXObserverGetRunLoopSource(
        observer: AXObserverRef,
    ) -> core_foundation_sys::runloop::CFRunLoopSourceRef;

    pub fn AXObserverAddNotification(
        observer: AXObserverRef,
        element: AXUIElementRef,
        notification: core_foundation_sys::string::CFStringRef,
        context: *mut c_void,
    ) -> AXError;

    #[allow(dead_code)]
    pub fn AXObserverRemoveNotification(
        observer: AXObserverRef,
        element: AXUIElementRef,
        notification: core_foundation_sys::string::CFStringRef,
    ) -> AXError;

    pub fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: core_foundation_sys::string::CFStringRef,
        value: *mut core_foundation_sys::base::CFTypeRef,
    ) -> AXError;

    /// Private but stable API: get the CGWindowID for an AXUIElement.
    fn _AXUIElementGetWindow(element: AXUIElementRef, window_id: *mut u32) -> AXError;
}

// --- AX Constants (defined as CFSTR macros in macOS headers) ---
// These are not exported symbols; they must be constructed at runtime.
// LazyLock ensures each constant is created exactly once (no leak-per-call).

/// Wrapper to make CFStringRef usable in LazyLock statics.
/// Safety: CFString objects are immutable and thread-safe once created.
struct SyncCFStr(core_foundation_sys::string::CFStringRef);
unsafe impl Send for SyncCFStr {}
unsafe impl Sync for SyncCFStr {}

/// Create a leaked CFStringRef that lives for the process lifetime.
fn ax_cfstr(s: &str) -> SyncCFStr {
    let cf = CFString::new(s);
    let ptr = cf.as_concrete_TypeRef();
    std::mem::forget(cf);
    SyncCFStr(ptr)
}

// Notification constants
static AX_WINDOW_CREATED: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXWindowCreated"));
static AX_UI_ELEMENT_DESTROYED: LazyLock<SyncCFStr> =
    LazyLock::new(|| ax_cfstr("AXUIElementDestroyed"));
static AX_FOCUSED_WINDOW_CHANGED: LazyLock<SyncCFStr> =
    LazyLock::new(|| ax_cfstr("AXFocusedWindowChanged"));
static AX_TITLE_CHANGED: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXTitleChanged"));

// Attribute constants
static AX_FOCUSED_WINDOW: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXFocusedWindow"));
static AX_DOCUMENT: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXDocument"));
static AX_TITLE: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXTitle"));

// Trusted check option
static AX_TRUSTED_CHECK_OPTION_PROMPT: LazyLock<SyncCFStr> =
    LazyLock::new(|| ax_cfstr("AXTrustedCheckOptionPrompt"));

pub fn k_ax_window_created_notification() -> core_foundation_sys::string::CFStringRef {
    AX_WINDOW_CREATED.0
}
pub fn k_ax_ui_element_destroyed_notification() -> core_foundation_sys::string::CFStringRef {
    AX_UI_ELEMENT_DESTROYED.0
}
pub fn k_ax_focused_window_changed_notification() -> core_foundation_sys::string::CFStringRef {
    AX_FOCUSED_WINDOW_CHANGED.0
}
pub fn k_ax_title_changed_notification() -> core_foundation_sys::string::CFStringRef {
    AX_TITLE_CHANGED.0
}
fn k_ax_focused_window_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_FOCUSED_WINDOW.0
}
fn k_ax_document_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_DOCUMENT.0
}
fn k_ax_title_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_TITLE.0
}
fn k_ax_trusted_check_option_prompt() -> core_foundation_sys::string::CFStringRef {
    AX_TRUSTED_CHECK_OPTION_PROMPT.0
}

// --- RAII Wrappers ---

/// RAII wrapper for AXUIElementRef.
pub struct SafeAXUIElement {
    raw: AXUIElementRef,
}

// Safety: AXUIElement is a CoreFoundation type that is safe to send between threads.
unsafe impl Send for SafeAXUIElement {}
unsafe impl Sync for SafeAXUIElement {}

impl SafeAXUIElement {
    pub fn new(raw: AXUIElementRef) -> Option<Self> {
        if raw.is_null() {
            None
        } else {
            Some(SafeAXUIElement { raw })
        }
    }

    pub fn raw(&self) -> AXUIElementRef {
        self.raw
    }
}

impl Drop for SafeAXUIElement {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                core_foundation_sys::base::CFRelease(self.raw as _);
            }
        }
    }
}

/// RAII wrapper for AXObserverRef.
pub struct SafeAXObserver {
    raw: AXObserverRef,
}

// Safety: AXObserver is a CoreFoundation type.
unsafe impl Send for SafeAXObserver {}
unsafe impl Sync for SafeAXObserver {}

impl SafeAXObserver {
    pub fn new(raw: AXObserverRef) -> Option<Self> {
        if raw.is_null() {
            None
        } else {
            Some(SafeAXObserver { raw })
        }
    }

    pub fn get_runloop_source(&self) -> Option<CFRunLoopSource> {
        let source_ref = unsafe { AXObserverGetRunLoopSource(self.raw) };
        if source_ref.is_null() {
            None
        } else {
            Some(unsafe { TCFType::wrap_under_get_rule(source_ref) })
        }
    }

    pub fn add_notification(
        &self,
        element: &SafeAXUIElement,
        notification: core_foundation_sys::string::CFStringRef,
        context: *mut c_void,
    ) -> AXError {
        unsafe { AXObserverAddNotification(self.raw, element.raw(), notification, context) }
    }

    #[allow(dead_code)]
    pub fn remove_notification(
        &self,
        element: &SafeAXUIElement,
        notification: core_foundation_sys::string::CFStringRef,
    ) -> AXError {
        unsafe { AXObserverRemoveNotification(self.raw, element.raw(), notification) }
    }
}

impl Drop for SafeAXObserver {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                core_foundation_sys::base::CFRelease(self.raw as _);
            }
        }
    }
}

// --- Helper Functions ---

/// Check if the current process is trusted for accessibility.
pub fn is_process_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Request accessibility trust with system prompt.
pub fn request_accessibility_permission() {
    unsafe {
        let key = k_ax_trusted_check_option_prompt();
        let value = core_foundation_sys::number::kCFBooleanTrue;
        let keys = [key as *const c_void];
        let values = [value as *const c_void];
        let options = core_foundation_sys::dictionary::CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &core_foundation_sys::dictionary::kCFTypeDictionaryKeyCallBacks,
            &core_foundation_sys::dictionary::kCFTypeDictionaryValueCallBacks,
        );
        AXIsProcessTrustedWithOptions(options);
        core_foundation_sys::base::CFRelease(options as _);
    }
}

/// Create an AXUIElement for an application PID.
pub fn create_app_element(pid: i32) -> Option<SafeAXUIElement> {
    let el = unsafe { AXUIElementCreateApplication(pid) };
    SafeAXUIElement::new(el)
}

/// Create an AXObserver for a PID with a callback.
pub fn create_observer(pid: i32, callback: AXObserverCallback) -> Option<SafeAXObserver> {
    let mut observer: AXObserverRef = ptr::null_mut();
    let err = unsafe { AXObserverCreate(pid, callback, &mut observer) };
    if err != K_AX_ERROR_SUCCESS || observer.is_null() {
        None
    } else {
        SafeAXObserver::new(observer)
    }
}

/// Get the focused window element of an app element.
pub fn get_focused_window(app_element: &SafeAXUIElement) -> Option<SafeAXUIElement> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            app_element.raw(),
            k_ax_focused_window_attribute(),
            &mut value,
        )
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    // value is already retained by CopyAttributeValue
    Some(SafeAXUIElement { raw: value as _ })
}

/// Get the AXDocument attribute (file URL) of a window element.
pub fn get_document(element: &SafeAXUIElement) -> Option<String> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_document_attribute(), &mut value)
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let cf_str: CFString = unsafe { TCFType::wrap_under_create_rule(value as _) };
    Some(cf_str.to_string())
}

/// Get the AXTitle attribute of a window element.
pub fn get_title(element: &SafeAXUIElement) -> Option<String> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_title_attribute(), &mut value)
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let cf_str: CFString = unsafe { TCFType::wrap_under_create_rule(value as _) };
    Some(cf_str.to_string())
}

/// Get the CGWindowID associated with an AXUIElement window.
/// Uses the private but widely-used and stable `_AXUIElementGetWindow` API.
pub fn get_window_id(element: &SafeAXUIElement) -> Option<u32> {
    let mut window_id: u32 = 0;
    let err = unsafe { _AXUIElementGetWindow(element.raw(), &mut window_id) };
    if err == K_AX_ERROR_SUCCESS && window_id != 0 {
        Some(window_id)
    } else {
        None
    }
}
