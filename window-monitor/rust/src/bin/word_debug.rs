use window_monitor_lib::accessibility;

fn main() {
    let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();
    let bundle_ns = objc2_foundation::NSString::from_str("com.microsoft.Word");
    let mut pid = None;
    let count = apps.count();
    for i in 0..count {
        let app: objc2::rc::Retained<objc2_app_kit::NSRunningApplication> = apps.objectAtIndex(i);
        if let Some(bid) = app.bundleIdentifier() {
            if bid.isEqualToString(&bundle_ns) {
                pid = Some(app.processIdentifier());
                break;
            }
        }
    }
    let pid = pid.expect("Word not running");

    let app_el = accessibility::create_app_element(pid).expect("No app element");
    let ax_win = accessibility::find_ax_window_by_id(&app_el, 56607).expect("No window");

    let text_areas = accessibility::find_all_text_areas_in_subtree(&ax_win, 10);
    if text_areas.is_empty() {
        eprintln!("No text areas");
        return;
    }

    // Set selection to "Private data is the differentiator" at doc offset 2407
    let position = 2407i64;
    let length = 34i64;
    accessibility::set_selected_text_range(&text_areas[0], position, length);
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Get text bounds
    let sel_range = accessibility::CFRange {
        location: position,
        length,
    };
    if let Some(text_bounds) = accessibility::get_bounds_for_range(&text_areas[0], &sel_range) {
        eprintln!(
            "Text bounds: x={}, y={}, w={}, h={}",
            text_bounds.origin.x, text_bounds.origin.y,
            text_bounds.size.width, text_bounds.size.height
        );
    }

    // Get window bounds
    if let Some(win_bounds) = accessibility::get_element_bounds(&ax_win) {
        eprintln!(
            "Window bounds: x={}, y={}, w={}, h={}",
            win_bounds.origin.x, win_bounds.origin.y,
            win_bounds.size.width, win_bounds.size.height
        );
    }

    // Get scroll bar info
    if let Some(scroll_bar) = accessibility::find_vertical_scroll_bar(&ax_win, 10) {
        if let Some(val) = accessibility::get_scroll_bar_value(&scroll_bar) {
            eprintln!("Current scroll bar value: {}", val);
        }

        // Test: what scroll value puts the text at various positions?
        // Save current value, try a few, report text_bounds.y for each
        let current = accessibility::get_scroll_bar_value(&scroll_bar).unwrap_or(0.0);

        let total_chars = accessibility::get_character_count(&text_areas[0]).unwrap_or(1) as f64;
        let char_ratio = position as f64 / total_chars;
        eprintln!("Char ratio: {}", char_ratio);

        // Try different scroll values around the estimate
        for offset in [-0.15, -0.10, -0.05, 0.0, 0.05] {
            let test_val = (char_ratio + offset).clamp(0.0, 1.0);
            accessibility::set_scroll_bar_value(&scroll_bar, test_val);
            std::thread::sleep(std::time::Duration::from_millis(100));

            if let Some(tb) = accessibility::get_bounds_for_range(&text_areas[0], &sel_range) {
                let win_bounds = accessibility::get_element_bounds(&ax_win).unwrap();
                let relative_y = tb.origin.y - win_bounds.origin.y;
                let pct = relative_y / win_bounds.size.height * 100.0;
                eprintln!(
                    "scroll={:.3}: text_y={:.0}, relative_y={:.0} ({:.1}% from top)",
                    test_val, tb.origin.y, relative_y, pct
                );
            }
        }

        // Restore
        accessibility::set_scroll_bar_value(&scroll_bar, current);
    }
}
