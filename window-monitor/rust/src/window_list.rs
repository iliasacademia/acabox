use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_graphics::display::{
    kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    CGWindowListCopyWindowInfo,
};
use std::ffi::c_void;

const MIN_WINDOW_DIMENSION: f64 = 50.0;

/// A window entry from CGWindowListCopyWindowInfo.
#[derive(Debug, Clone)]
pub struct WindowListEntry {
    pub window_id: u32,
    pub name: Option<String>,
    pub bounds: WindowBounds,
    #[allow(dead_code)]
    pub owner_pid: i32,
}

/// Bounds from CGWindow.
#[derive(Debug, Clone)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Get all on-screen windows for a given PID.
/// Filters: include windows with a name or size > 50x50.
pub fn get_windows_for_pid(pid: i32) -> Vec<WindowListEntry> {
    if pid == 0 {
        return Vec::new();
    }

    let window_list = unsafe {
        CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )
    };

    if window_list.is_null() {
        return Vec::new();
    }

    let count =
        unsafe { core_foundation_sys::array::CFArrayGetCount(window_list) };
    let mut result = Vec::new();

    for i in 0..count {
        let dict_ref = unsafe {
            core_foundation_sys::array::CFArrayGetValueAtIndex(window_list, i)
        };
        if dict_ref.is_null() {
            continue;
        }
        let dict = dict_ref as core_foundation_sys::dictionary::CFDictionaryRef;

        // Get owner PID
        let owner_pid = get_cf_dict_number(dict, "kCGWindowOwnerPID").unwrap_or(0) as i32;
        if owner_pid != pid {
            continue;
        }

        // Get window ID
        let window_id = get_cf_dict_number(dict, "kCGWindowNumber").unwrap_or(0) as u32;

        // Get window name
        let name = get_cf_dict_string(dict, "kCGWindowName");

        // Get bounds
        let bounds = get_cf_dict_bounds(dict);

        // Filter: include windows with names or reasonable size
        let has_name = name.as_ref().map_or(false, |n| !n.is_empty());
        let has_size = bounds.width > MIN_WINDOW_DIMENSION && bounds.height > MIN_WINDOW_DIMENSION;

        if has_name || has_size {
            result.push(WindowListEntry {
                window_id,
                name,
                bounds,
                owner_pid,
            });
        }
    }

    unsafe {
        core_foundation_sys::base::CFRelease(window_list as *const c_void);
    }

    result
}

fn get_cf_dict_number(
    dict: core_foundation_sys::dictionary::CFDictionaryRef,
    key: &str,
) -> Option<i64> {
    let cf_key = CFString::new(key);
    let mut value: *const c_void = std::ptr::null();
    let found = unsafe {
        core_foundation_sys::dictionary::CFDictionaryGetValueIfPresent(
            dict,
            cf_key.as_concrete_TypeRef() as *const c_void,
            &mut value,
        )
    };
    if found == 0 || value.is_null() {
        return None;
    }
    let number: core_foundation::number::CFNumber =
        unsafe { TCFType::wrap_under_get_rule(value as _) };
    number.to_i64()
}

fn get_cf_dict_string(
    dict: core_foundation_sys::dictionary::CFDictionaryRef,
    key: &str,
) -> Option<String> {
    let cf_key = CFString::new(key);
    let mut value: *const c_void = std::ptr::null();
    let found = unsafe {
        core_foundation_sys::dictionary::CFDictionaryGetValueIfPresent(
            dict,
            cf_key.as_concrete_TypeRef() as *const c_void,
            &mut value,
        )
    };
    if found == 0 || value.is_null() {
        return None;
    }
    let cf_str: CFString = unsafe { TCFType::wrap_under_get_rule(value as _) };
    Some(cf_str.to_string())
}

fn get_cf_dict_bounds(dict: core_foundation_sys::dictionary::CFDictionaryRef) -> WindowBounds {
    let cf_key = CFString::new("kCGWindowBounds");
    let mut value: *const c_void = std::ptr::null();
    let found = unsafe {
        core_foundation_sys::dictionary::CFDictionaryGetValueIfPresent(
            dict,
            cf_key.as_concrete_TypeRef() as *const c_void,
            &mut value,
        )
    };
    if found != 0 && !value.is_null() {
        let bounds_dict = value as core_foundation_sys::dictionary::CFDictionaryRef;
        let x = get_bounds_dict_number(bounds_dict, "X").unwrap_or(0.0);
        let y = get_bounds_dict_number(bounds_dict, "Y").unwrap_or(0.0);
        let width = get_bounds_dict_number(bounds_dict, "Width").unwrap_or(0.0);
        let height = get_bounds_dict_number(bounds_dict, "Height").unwrap_or(0.0);
        return WindowBounds {
            x,
            y,
            width,
            height,
        };
    }
    WindowBounds {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    }
}

fn get_bounds_dict_number(
    dict: core_foundation_sys::dictionary::CFDictionaryRef,
    key: &str,
) -> Option<f64> {
    let cf_key = CFString::new(key);
    let mut value: *const c_void = std::ptr::null();
    let found = unsafe {
        core_foundation_sys::dictionary::CFDictionaryGetValueIfPresent(
            dict,
            cf_key.as_concrete_TypeRef() as *const c_void,
            &mut value,
        )
    };
    if found == 0 || value.is_null() {
        return None;
    }
    let number: core_foundation::number::CFNumber =
        unsafe { TCFType::wrap_under_get_rule(value as _) };
    number.to_f64()
}
