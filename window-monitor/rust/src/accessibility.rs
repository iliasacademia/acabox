use core_foundation::base::TCFType;
use core_foundation::runloop::CFRunLoopSource;
use core_foundation::string::CFString;
use std::ffi::c_void;
use std::ptr;

// --- Raw FFI bindings for Accessibility API ---

pub type AXUIElementRef = *mut c_void;
pub type AXObserverRef = *mut c_void;
pub type AXValueRef = *mut c_void;
pub type AXError = i32;

pub const K_AX_ERROR_SUCCESS: AXError = 0;

// AXValue types
pub const K_AX_VALUE_TYPE_CGPOINT: u32 = 1;
pub const K_AX_VALUE_TYPE_CGSIZE: u32 = 2;

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

    pub fn AXValueGetValue(
        value: AXValueRef,
        value_type: u32,
        value_ptr: *mut c_void,
    ) -> bool;
}

// --- AX Constants (defined as CFSTR macros in macOS headers) ---
// These are not exported symbols; they must be constructed at runtime.

/// Helper to create a static-like CFStringRef from a string literal.
/// The returned CFString is leaked intentionally (lives for the process lifetime).
fn ax_cfstr(s: &str) -> core_foundation_sys::string::CFStringRef {
    let cf = CFString::new(s);
    let ptr = cf.as_concrete_TypeRef();
    std::mem::forget(cf); // Leak: these are process-lifetime constants
    ptr
}

// Notification constants
pub fn k_ax_window_created_notification() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXWindowCreated")
}
pub fn k_ax_ui_element_destroyed_notification() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXUIElementDestroyed")
}
pub fn k_ax_focused_window_changed_notification() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXFocusedWindowChanged")
}
pub fn k_ax_moved_notification() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXMoved")
}
pub fn k_ax_resized_notification() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXResized")
}

// Attribute constants
pub fn k_ax_focused_window_attribute() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXFocusedWindow")
}
pub fn k_ax_windows_attribute() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXWindows")
}
pub fn k_ax_position_attribute() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXPosition")
}
pub fn k_ax_size_attribute() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXSize")
}
pub fn k_ax_role_attribute() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXRole")
}
pub fn k_ax_document_attribute() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXDocument")
}

// Trusted check option
pub fn k_ax_trusted_check_option_prompt() -> core_foundation_sys::string::CFStringRef {
    ax_cfstr("AXTrustedCheckOptionPrompt")
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

    /// Retain and return a new SafeAXUIElement pointing to the same element.
    pub fn retain(&self) -> SafeAXUIElement {
        unsafe {
            core_foundation_sys::base::CFRetain(self.raw as _);
        }
        SafeAXUIElement { raw: self.raw }
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

/// Get all AX windows of an app element.
pub fn get_ax_windows(app_element: &SafeAXUIElement) -> Vec<SafeAXUIElement> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            app_element.raw(),
            k_ax_windows_attribute(),
            &mut value,
        )
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return Vec::new();
    }

    let array_ref = value as core_foundation_sys::array::CFArrayRef;
    let count = unsafe { core_foundation_sys::array::CFArrayGetCount(array_ref) };
    let mut result = Vec::new();

    for i in 0..count {
        let el_ptr = unsafe { core_foundation_sys::array::CFArrayGetValueAtIndex(array_ref, i) };
        if !el_ptr.is_null() {
            // Retain the element since we're pulling it out of the array
            unsafe {
                core_foundation_sys::base::CFRetain(el_ptr);
            }
            result.push(SafeAXUIElement {
                raw: el_ptr as AXUIElementRef,
            });
        }
    }

    // Release the array
    unsafe {
        core_foundation_sys::base::CFRelease(value);
    }

    result
}

/// Get the position (CGPoint) of a window element.
pub fn get_position(element: &SafeAXUIElement) -> Option<(f64, f64)> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_position_attribute(), &mut value)
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }

    let mut point = core_graphics::geometry::CGPoint::new(0.0, 0.0);
    let ok = unsafe {
        AXValueGetValue(
            value as _,
            K_AX_VALUE_TYPE_CGPOINT,
            &mut point as *mut _ as *mut c_void,
        )
    };

    unsafe {
        core_foundation_sys::base::CFRelease(value);
    }

    if ok {
        Some((point.x, point.y))
    } else {
        None
    }
}

/// Get the size (CGSize) of a window element.
pub fn get_size(element: &SafeAXUIElement) -> Option<(f64, f64)> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_size_attribute(), &mut value)
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }

    let mut size = core_graphics::geometry::CGSize::new(0.0, 0.0);
    let ok = unsafe {
        AXValueGetValue(
            value as _,
            K_AX_VALUE_TYPE_CGSIZE,
            &mut size as *mut _ as *mut c_void,
        )
    };

    unsafe {
        core_foundation_sys::base::CFRelease(value);
    }

    if ok {
        Some((size.width, size.height))
    } else {
        None
    }
}

/// Get the bounds (position + size) of a window element.
pub fn get_bounds(element: &SafeAXUIElement) -> Option<(f64, f64, f64, f64)> {
    let (x, y) = get_position(element)?;
    let (w, h) = get_size(element)?;
    Some((x, y, w, h))
}

/// Get the AXRole string of a window element.
pub fn get_role(element: &SafeAXUIElement) -> Option<String> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_role_attribute(), &mut value)
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let cf_str: CFString = unsafe { TCFType::wrap_under_create_rule(value as _) };
    Some(cf_str.to_string())
}

/// Get the AXDocument attribute (file path) of a window element.
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
