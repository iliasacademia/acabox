use core_foundation::base::TCFType;
use core_foundation::runloop::CFRunLoopSource;
use core_foundation::string::CFString;
use core_graphics_types::geometry::CGRect;
use std::ffi::c_void;
use std::ptr;
use std::sync::LazyLock;

// --- Raw FFI bindings for Accessibility API ---

pub type AXUIElementRef = *mut c_void;
pub type AXObserverRef = *mut c_void;
pub type AXError = i32;

pub const K_AX_ERROR_SUCCESS: AXError = 0;

// AXValue type constants
const AX_VALUE_TYPE_CGPOINT: u32 = 1;
const AX_VALUE_TYPE_CGSIZE: u32 = 2;
const AX_VALUE_TYPE_CGRECT: u32 = 3;
const AX_VALUE_TYPE_CFRANGE: u32 = 4;

/// CFRange struct matching the CoreFoundation layout.
#[repr(C)]
pub struct CFRange {
    pub location: i64,
    pub length: i64,
}

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

    pub fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: core_foundation_sys::string::CFStringRef,
        value: core_foundation_sys::base::CFTypeRef,
    ) -> AXError;

    pub fn AXUIElementCopyParameterizedAttributeValue(
        element: AXUIElementRef,
        parameterized_attribute: core_foundation_sys::string::CFStringRef,
        parameter: core_foundation_sys::base::CFTypeRef,
        result: *mut core_foundation_sys::base::CFTypeRef,
    ) -> AXError;

    pub fn AXValueCreate(
        value_type: u32,
        value: *const c_void,
    ) -> core_foundation_sys::base::CFTypeRef;

    pub fn AXValueGetValue(
        value: core_foundation_sys::base::CFTypeRef,
        value_type: u32,
        value_out: *mut c_void,
    ) -> bool;

    pub fn AXUIElementPerformAction(
        element: AXUIElementRef,
        action: core_foundation_sys::string::CFStringRef,
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
static AX_UI_ELEMENT_DESTROYED: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXUIElementDestroyed"));
static AX_FOCUSED_WINDOW_CHANGED: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXFocusedWindowChanged"));
static AX_MOVED: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXMoved"));
static AX_RESIZED: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXResized"));
static AX_TITLE_CHANGED: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXTitleChanged"));

// Attribute constants
static AX_FOCUSED_WINDOW: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXFocusedWindow"));
static AX_WINDOWS: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXWindows"));
static AX_ROLE: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXRole"));
static AX_DOCUMENT: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXDocument"));
static AX_FOCUSED_UI_ELEMENT: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXFocusedUIElement"));
static AX_SELECTED_TEXT: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXSelectedText"));
static AX_VALUE: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXValue"));
static AX_NUMBER_OF_CHARACTERS: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXNumberOfCharacters"));
static AX_CHILDREN: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXChildren"));
static AX_SELECTED_TEXT_RANGE: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXSelectedTextRange"));
static AX_BOUNDS_FOR_RANGE: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXBoundsForRange"));
static AX_POSITION: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXPosition"));
static AX_SIZE: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXSize"));
static AX_ORIENTATION: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXOrientation"));

// Trusted check option
static AX_TRUSTED_CHECK_OPTION_PROMPT: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXTrustedCheckOptionPrompt"));

pub fn k_ax_window_created_notification() -> core_foundation_sys::string::CFStringRef {
    AX_WINDOW_CREATED.0
}
pub fn k_ax_ui_element_destroyed_notification() -> core_foundation_sys::string::CFStringRef {
    AX_UI_ELEMENT_DESTROYED.0
}
pub fn k_ax_focused_window_changed_notification() -> core_foundation_sys::string::CFStringRef {
    AX_FOCUSED_WINDOW_CHANGED.0
}
pub fn k_ax_moved_notification() -> core_foundation_sys::string::CFStringRef {
    AX_MOVED.0
}
pub fn k_ax_resized_notification() -> core_foundation_sys::string::CFStringRef {
    AX_RESIZED.0
}
pub fn k_ax_title_changed_notification() -> core_foundation_sys::string::CFStringRef {
    AX_TITLE_CHANGED.0
}
fn k_ax_focused_window_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_FOCUSED_WINDOW.0
}
fn k_ax_windows_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_WINDOWS.0
}
fn k_ax_role_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_ROLE.0
}
fn k_ax_document_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_DOCUMENT.0
}
fn k_ax_focused_ui_element_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_FOCUSED_UI_ELEMENT.0
}
fn k_ax_selected_text_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_SELECTED_TEXT.0
}
fn k_ax_value_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_VALUE.0
}
fn k_ax_number_of_characters_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_NUMBER_OF_CHARACTERS.0
}
fn k_ax_children_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_CHILDREN.0
}
fn k_ax_selected_text_range_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_SELECTED_TEXT_RANGE.0
}
fn k_ax_bounds_for_range_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_BOUNDS_FOR_RANGE.0
}
fn k_ax_position_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_POSITION.0
}
fn k_ax_size_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_SIZE.0
}
fn k_ax_orientation_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_ORIENTATION.0
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

/// Get the focused UI element of an app element (e.g. the text area being edited).
pub fn get_focused_ui_element(app_element: &SafeAXUIElement) -> Option<SafeAXUIElement> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            app_element.raw(),
            k_ax_focused_ui_element_attribute(),
            &mut value,
        )
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    Some(SafeAXUIElement { raw: value as _ })
}

/// Get the selected text from a UI element via AXSelectedText.
pub fn get_selected_text(element: &SafeAXUIElement) -> Option<String> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_selected_text_attribute(), &mut value)
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let cf_str: CFString = unsafe { TCFType::wrap_under_create_rule(value as _) };
    Some(cf_str.to_string())
}

/// Get the full text value from a UI element via AXValue.
pub fn get_text_value(element: &SafeAXUIElement) -> Option<String> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_value_attribute(), &mut value)
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let cf_str: CFString = unsafe { TCFType::wrap_under_create_rule(value as _) };
    Some(cf_str.to_string())
}

/// Get the number of characters in a UI element via AXNumberOfCharacters.
pub fn get_character_count(element: &SafeAXUIElement) -> Option<i64> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            element.raw(),
            k_ax_number_of_characters_attribute(),
            &mut value,
        )
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let number: core_foundation::number::CFNumber =
        unsafe { TCFType::wrap_under_create_rule(value as _) };
    number.to_i64()
}

/// Get all AX children of an element.
pub fn get_children(element: &SafeAXUIElement) -> Vec<SafeAXUIElement> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_children_attribute(), &mut value)
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
            unsafe {
                core_foundation_sys::base::CFRetain(el_ptr);
            }
            result.push(SafeAXUIElement {
                raw: el_ptr as AXUIElementRef,
            });
        }
    }

    unsafe {
        core_foundation_sys::base::CFRelease(value);
    }

    result
}

/// Find an AX window element matching a CGWindowID within an app element.
pub fn find_ax_window_by_id(
    app_element: &SafeAXUIElement,
    window_id: u32,
) -> Option<SafeAXUIElement> {
    let ax_windows = get_ax_windows(app_element);
    for ax_win in ax_windows {
        if get_window_id(&ax_win) == Some(window_id) {
            return Some(ax_win);
        }
    }
    None
}

/// Perform AXRaise on a window element to bring it to the front.
pub fn raise_window(window: &SafeAXUIElement) {
    let action = CFString::new("AXRaise");
    unsafe {
        AXUIElementPerformAction(window.raw(), action.as_concrete_TypeRef());
    }
}

/// Get the selected text range (location + length) from a UI element via AXSelectedTextRange.
pub fn get_selected_text_range(element: &SafeAXUIElement) -> Option<CFRange> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            element.raw(),
            k_ax_selected_text_range_attribute(),
            &mut value,
        )
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    let ok = unsafe {
        AXValueGetValue(
            value,
            AX_VALUE_TYPE_CFRANGE,
            &mut range as *mut CFRange as *mut c_void,
        )
    };
    unsafe {
        core_foundation_sys::base::CFRelease(value);
    }
    if ok { Some(range) } else { None }
}

/// Get the screen bounds (CGRect) for a text range via AXBoundsForRange parameterized attribute.
pub fn get_bounds_for_range(element: &SafeAXUIElement, range: &CFRange) -> Option<CGRect> {
    let range_value = unsafe {
        AXValueCreate(
            AX_VALUE_TYPE_CFRANGE,
            range as *const CFRange as *const c_void,
        )
    };
    if range_value.is_null() {
        return None;
    }
    let mut result: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            element.raw(),
            k_ax_bounds_for_range_attribute(),
            range_value,
            &mut result,
        )
    };
    unsafe {
        core_foundation_sys::base::CFRelease(range_value);
    }
    if err != K_AX_ERROR_SUCCESS || result.is_null() {
        return None;
    }
    let mut rect = CGRect::default();
    let ok = unsafe {
        AXValueGetValue(
            result,
            AX_VALUE_TYPE_CGRECT,
            &mut rect as *mut CGRect as *mut c_void,
        )
    };
    unsafe {
        core_foundation_sys::base::CFRelease(result);
    }
    if ok { Some(rect) } else { None }
}

/// Get the screen bounds of the current text selection (convenience wrapper).
pub fn get_selection_bounds(element: &SafeAXUIElement) -> Option<CGRect> {
    let range = get_selected_text_range(element)?;
    if range.length == 0 {
        return None;
    }
    get_bounds_for_range(element, &range)
}

/// Get the screen bounds of an AX element by reading AXPosition + AXSize.
pub fn get_element_bounds(element: &SafeAXUIElement) -> Option<CGRect> {
    // Read AXPosition -> CGPoint
    let mut pos_value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_position_attribute(), &mut pos_value)
    };
    if err != K_AX_ERROR_SUCCESS || pos_value.is_null() {
        return None;
    }
    let mut point = core_graphics_types::geometry::CGPoint::default();
    let ok = unsafe {
        AXValueGetValue(
            pos_value,
            AX_VALUE_TYPE_CGPOINT,
            &mut point as *mut core_graphics_types::geometry::CGPoint as *mut c_void,
        )
    };
    unsafe {
        core_foundation_sys::base::CFRelease(pos_value);
    }
    if !ok {
        return None;
    }

    // Read AXSize -> CGSize
    let mut size_value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_size_attribute(), &mut size_value)
    };
    if err != K_AX_ERROR_SUCCESS || size_value.is_null() {
        return None;
    }
    let mut size = core_graphics_types::geometry::CGSize::default();
    let ok = unsafe {
        AXValueGetValue(
            size_value,
            AX_VALUE_TYPE_CGSIZE,
            &mut size as *mut core_graphics_types::geometry::CGSize as *mut c_void,
        )
    };
    unsafe {
        core_foundation_sys::base::CFRelease(size_value);
    }
    if !ok {
        return None;
    }

    Some(CGRect::new(&point, &size))
}

/// Find the document content area of a window element by selecting the largest
/// direct child by area. When `role_filter` is provided, only children matching
/// that AX role are considered (e.g. "AXSplitGroup" for Microsoft Word). When
/// `None`, all direct children compete and the largest wins.
pub fn find_content_area_child(
    element: &SafeAXUIElement,
    role_filter: Option<&str>,
) -> Option<SafeAXUIElement> {
    let children = get_children(element);
    let mut best: Option<(SafeAXUIElement, f64)> = None;
    for child in children {
        if let Some(required_role) = role_filter {
            match get_role(&child) {
                Some(role) if role == required_role => {}
                _ => continue,
            }
        }
        if let Some(rect) = get_element_bounds(&child) {
            let area = rect.size.width * rect.size.height;
            if best.as_ref().map_or(true, |(_, best_area)| area > *best_area) {
                best = Some((child, area));
            }
        }
    }
    best.map(|(el, _)| el)
}

/// DFS to find the first AXTextArea element in a subtree, with a depth limit.
/// In Microsoft Word, AXTextArea elements are nested inside AXLayoutArea → AXGroup → AXGroup
/// at ~depth 3-4 from the window's AXScrollArea.
pub fn find_text_area_in_subtree(
    element: &SafeAXUIElement,
    max_depth: u32,
) -> Option<SafeAXUIElement> {
    if max_depth == 0 {
        return None;
    }

    fn search(element: &SafeAXUIElement, depth_remaining: u32) -> Option<SafeAXUIElement> {
        if depth_remaining == 0 {
            return None;
        }

        let children = get_children(element);
        for child in children {
            if let Some(role) = get_role(&child) {
                if role == "AXTextArea" {
                    return Some(child);
                }
            }
            if let Some(found) = search(&child, depth_remaining - 1) {
                return Some(found);
            }
        }
        None
    }

    search(element, max_depth)
}

/// DFS to find ALL AXTextArea elements in a subtree, with a depth limit.
/// Word exposes each page as a separate AXTextArea, so we need to collect all of them
/// to capture the full document text.
pub fn find_all_text_areas_in_subtree(
    element: &SafeAXUIElement,
    max_depth: u32,
) -> Vec<SafeAXUIElement> {
    if max_depth == 0 {
        return Vec::new();
    }

    fn search(element: &SafeAXUIElement, depth_remaining: u32, result: &mut Vec<SafeAXUIElement>) {
        if depth_remaining == 0 {
            return;
        }

        let children = get_children(element);
        for child in children {
            if let Some(role) = get_role(&child) {
                if role == "AXTextArea" {
                    result.push(child);
                    continue; // Don't recurse into text areas
                }
            }
            search(&child, depth_remaining - 1, result);
        }
    }

    let mut result = Vec::new();
    search(element, max_depth, &mut result);
    result
}

/// Set the selected text range on a UI element via AXSelectedTextRange.
/// The offset is document-global (not per-page). Setting on any text area works —
/// Word routes it to the correct page.
pub fn set_selected_text_range(element: &SafeAXUIElement, location: i64, length: i64) -> bool {
    let range = CFRange { location, length };
    let range_value = unsafe {
        AXValueCreate(
            AX_VALUE_TYPE_CFRANGE,
            &range as *const CFRange as *const c_void,
        )
    };
    if range_value.is_null() {
        return false;
    }
    let err = unsafe {
        AXUIElementSetAttributeValue(
            element.raw(),
            k_ax_selected_text_range_attribute(),
            range_value,
        )
    };
    unsafe {
        core_foundation_sys::base::CFRelease(range_value);
    }
    err == K_AX_ERROR_SUCCESS
}

/// Get a string attribute from an AX element.
fn get_string_attribute(
    element: &SafeAXUIElement,
    attribute: core_foundation_sys::string::CFStringRef,
) -> Option<String> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(element.raw(), attribute, &mut value) };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let cf_str: CFString = unsafe { TCFType::wrap_under_create_rule(value as _) };
    Some(cf_str.to_string())
}

/// DFS to find the vertical scroll bar in an AX subtree.
/// Looks for AXRole == "AXScrollBar" with AXOrientation == "AXVerticalOrientation".
pub fn find_vertical_scroll_bar(
    element: &SafeAXUIElement,
    max_depth: u32,
) -> Option<SafeAXUIElement> {
    if max_depth == 0 {
        return None;
    }

    fn search(element: &SafeAXUIElement, depth_remaining: u32) -> Option<SafeAXUIElement> {
        if depth_remaining == 0 {
            return None;
        }

        let children = get_children(element);
        for child in children {
            if let Some(role) = get_role(&child) {
                if role == "AXScrollBar" {
                    if let Some(orientation) =
                        get_string_attribute(&child, k_ax_orientation_attribute())
                    {
                        if orientation == "AXVerticalOrientation" {
                            return Some(child);
                        }
                    }
                    continue;
                }
            }
            if let Some(found) = search(&child, depth_remaining - 1) {
                return Some(found);
            }
        }
        None
    }

    search(element, max_depth)
}

/// Get the current value of a scroll bar (0.0–1.0).
pub fn get_scroll_bar_value(element: &SafeAXUIElement) -> Option<f64> {
    let mut value: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element.raw(), k_ax_value_attribute(), &mut value)
    };
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    let number: core_foundation::number::CFNumber =
        unsafe { TCFType::wrap_under_create_rule(value as _) };
    number.to_f64()
}

/// Set the value of a scroll bar (0.0–1.0).
pub fn set_scroll_bar_value(element: &SafeAXUIElement, value: f64) -> bool {
    let cf_number = core_foundation::number::CFNumber::from(value);
    let err = unsafe {
        AXUIElementSetAttributeValue(
            element.raw(),
            k_ax_value_attribute(),
            cf_number.as_concrete_TypeRef() as core_foundation_sys::base::CFTypeRef,
        )
    };
    err == K_AX_ERROR_SUCCESS
}

// AXStringForRange / AXAttributedStringForRange constants
static AX_STRING_FOR_RANGE: LazyLock<SyncCFStr> = LazyLock::new(|| ax_cfstr("AXStringForRange"));
static AX_ATTRIBUTED_STRING_FOR_RANGE: LazyLock<SyncCFStr> =
    LazyLock::new(|| ax_cfstr("AXAttributedStringForRange"));

fn k_ax_string_for_range_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_STRING_FOR_RANGE.0
}

/// Get the text string for a document-coordinate range via AXStringForRange.
/// Note: the returned string may be longer than `length` due to paragraph mark expansion.
pub fn get_string_for_range(
    element: &SafeAXUIElement,
    location: i64,
    length: i64,
) -> Option<String> {
    let range = CFRange { location, length };
    let range_value = unsafe {
        AXValueCreate(
            AX_VALUE_TYPE_CFRANGE,
            &range as *const CFRange as *const c_void,
        )
    };
    if range_value.is_null() {
        return None;
    }
    let mut result: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            element.raw(),
            k_ax_string_for_range_attribute(),
            range_value,
            &mut result,
        )
    };
    unsafe {
        core_foundation_sys::base::CFRelease(range_value);
    }
    if err != K_AX_ERROR_SUCCESS || result.is_null() {
        return None;
    }
    let cf_str: CFString = unsafe { TCFType::wrap_under_create_rule(result as _) };
    Some(cf_str.to_string())
}

/// Font style info extracted from an attributed string.
pub struct FontStyle {
    pub font_name: String,
    pub font_size: f64,
}

fn k_ax_attributed_string_for_range_attribute() -> core_foundation_sys::string::CFStringRef {
    AX_ATTRIBUTED_STRING_FOR_RANGE.0
}

/// Get font style of the character at `location` via AXAttributedStringForRange.
/// Queries a single character and extracts the CTFont attributes.
pub fn get_font_style_at(element: &SafeAXUIElement, location: i64) -> Option<FontStyle> {
    let range = CFRange {
        location,
        length: 1,
    };
    let range_value = unsafe {
        AXValueCreate(
            AX_VALUE_TYPE_CFRANGE,
            &range as *const CFRange as *const c_void,
        )
    };
    if range_value.is_null() {
        return None;
    }

    let mut result: core_foundation_sys::base::CFTypeRef = ptr::null();
    let err = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            element.raw(),
            k_ax_attributed_string_for_range_attribute(),
            range_value,
            &mut result,
        )
    };
    unsafe {
        core_foundation_sys::base::CFRelease(range_value);
    }
    if err != K_AX_ERROR_SUCCESS || result.is_null() {
        eprintln!("[debug font] AXAttributedStringForRange failed: err={}, null={}", err, result.is_null());
        return None;
    }

    // result is an NSAttributedString. Check its length via objc2.
    use objc2::runtime::AnyObject;

    let len: usize = unsafe { objc2::msg_send![result as *const AnyObject, length] };
    eprintln!("[debug font] attributed string length: {}", len);
    if len == 0 {
        unsafe { core_foundation_sys::base::CFRelease(result) };
        return None;
    }

    // Use Objective-C runtime to call -[NSAttributedString attributesAtIndex:effectiveRange:]
    // which returns an NSDictionary. The AXFont key maps to another NSDictionary
    // with AXFontName/AXFontSize.

    let style = unsafe {
        // result is an NSAttributedString (toll-free bridged with CFAttributedString)
        let ns_astr = result as *const AnyObject;

        // Get attributes dict at index 0
        let attrs: *const AnyObject = objc2::msg_send![
            ns_astr,
            attributesAtIndex: 0usize,
            effectiveRange: ptr::null_mut::<objc2_foundation::NSRange>()
        ];

        if attrs.is_null() {
            eprintln!("[debug font] attributesAtIndex returned null");
            core_foundation_sys::base::CFRelease(result);
            return None;
        }

        // Log all keys for debugging
        let all_keys: *const AnyObject = objc2::msg_send![attrs, allKeys];
        if !all_keys.is_null() {
            let count: usize = objc2::msg_send![all_keys, count];
            for i in 0..count {
                let key: *const AnyObject = objc2::msg_send![all_keys, objectAtIndex: i];
                if !key.is_null() {
                    let desc: *const AnyObject = objc2::msg_send![key, description];
                    if !desc.is_null() {
                        let utf8: *const u8 = objc2::msg_send![desc, UTF8String];
                        if !utf8.is_null() {
                            let s = std::ffi::CStr::from_ptr(utf8 as *const _).to_string_lossy();
                            eprintln!("[debug font] attribute key: {}", s);
                        }
                    }
                }
            }
        }

        // Look up AXFont key
        let ax_font_key = objc2_foundation::NSString::from_str("AXFont");
        let font_dict: *const AnyObject = objc2::msg_send![
            attrs,
            objectForKey: &*ax_font_key
        ];

        if font_dict.is_null() {
            eprintln!("[debug font] AXFont key not found in attributes");
            core_foundation_sys::base::CFRelease(result);
            return None;
        }

        // Extract AXFontName
        let name_key = objc2_foundation::NSString::from_str("AXFontName");
        let name_obj: *const AnyObject = objc2::msg_send![font_dict, objectForKey: &*name_key];
        let font_name = if !name_obj.is_null() {
            let utf8: *const u8 = objc2::msg_send![name_obj, UTF8String];
            if !utf8.is_null() {
                std::ffi::CStr::from_ptr(utf8 as *const _)
                    .to_string_lossy()
                    .into_owned()
            } else {
                "Calibri".to_string()
            }
        } else {
            "Calibri".to_string()
        };

        // Extract AXFontSize
        let size_key = objc2_foundation::NSString::from_str("AXFontSize");
        let size_obj: *const AnyObject = objc2::msg_send![font_dict, objectForKey: &*size_key];
        let font_size = if !size_obj.is_null() {
            let val: f64 = objc2::msg_send![size_obj, doubleValue];
            val
        } else {
            12.0
        };

        eprintln!("[debug font] font_name='{}', font_size={}", font_name, font_size);
        Some(FontStyle { font_name, font_size })
    };

    unsafe { core_foundation_sys::base::CFRelease(result) };
    style
}
