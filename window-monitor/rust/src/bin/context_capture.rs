use serde_json::json;
use window_monitor_lib::accessibility::{self, SafeAXUIElement};

/// Recursively search for AXSelectedText in the subtree, trying common container types
/// (AXWebArea, AXTextArea, AXTextField, AXGroup, AXScrollArea) and the element itself.
/// Stops at max_depth to avoid traversing the entire accessibility tree.
fn find_selected_text_in_subtree(element: &SafeAXUIElement, max_depth: u32) -> Option<String> {
    if max_depth == 0 {
        return None;
    }

    // Try this element first
    if let Some(sel) = accessibility::get_selected_text(element) {
        if !sel.is_empty() {
            return Some(sel);
        }
    }

    // Recurse into children
    let children = accessibility::get_children(element);
    for child in &children {
        if let Some(sel) = find_selected_text_in_subtree(child, max_depth - 1) {
            return Some(sel);
        }
    }

    None
}

/// Collect selected text from ALL AXTextArea and AXWebArea elements in the subtree.
/// This handles Word's multi-page text areas and browser web areas.
fn collect_all_selections_in_subtree(element: &SafeAXUIElement, max_depth: u32) -> Vec<String> {
    let mut results = Vec::new();
    collect_selections_recursive(element, max_depth, &mut results);
    results
}

fn collect_selections_recursive(
    element: &SafeAXUIElement,
    depth_remaining: u32,
    results: &mut Vec<String>,
) {
    if depth_remaining == 0 {
        return;
    }

    let role = accessibility::get_role(element);
    let role_str = role.as_deref().unwrap_or("");

    // Check text-bearing elements for selected text
    if matches!(role_str, "AXTextArea" | "AXWebArea" | "AXTextField") {
        if let Some(sel) = accessibility::get_selected_text(element) {
            if !sel.is_empty() {
                results.push(sel);
            }
        }
        // For AXTextArea, don't recurse (leaf text container)
        // For AXWebArea, recurse further in case of nested content
        if role_str == "AXTextArea" {
            return;
        }
    }

    let children = accessibility::get_children(element);
    for child in &children {
        collect_selections_recursive(child, depth_remaining - 1, results);
    }
}

fn main() {
    let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
    let frontmost = workspace.frontmostApplication();

    let app_name = frontmost
        .as_ref()
        .and_then(|app| app.localizedName())
        .map(|n| n.to_string());

    let bundle_id = frontmost
        .as_ref()
        .and_then(|app| app.bundleIdentifier())
        .map(|b| b.to_string());

    let pid = frontmost.as_ref().map(|app| app.processIdentifier());

    let mut selected_text: Option<String> = None;
    let mut focused_role: Option<String> = None;
    let mut focused_value: Option<String> = None;

    if let Some(pid) = pid {
        if let Some(app_el) = accessibility::create_app_element(pid) {
            // Get focused element info
            if let Some(focused) = accessibility::get_focused_ui_element(&app_el) {
                focused_role = accessibility::get_role(&focused);
                focused_value = accessibility::get_text_value(&focused);

                // Try getting selected text directly from focused element
                selected_text = accessibility::get_selected_text(&focused)
                    .filter(|s| !s.is_empty());

                // If focused element is a container (group, scroll area, web area),
                // try searching its subtree for selected text
                if selected_text.is_none() {
                    selected_text = find_selected_text_in_subtree(&focused, 8);
                }
            }

            // If still no selection, traverse the focused window's full subtree.
            // This handles Word (multi-page AXTextArea) and browsers (AXWebArea).
            if selected_text.is_none() {
                if let Some(focused_window) = accessibility::get_focused_window(&app_el) {
                    let selections = collect_all_selections_in_subtree(&focused_window, 12);
                    if !selections.is_empty() {
                        selected_text = Some(selections.join("\n"));
                    }
                }
            }
        }
    }

    let output = json!({
        "frontmostApp": app_name,
        "bundleId": bundle_id,
        "selectedText": selected_text,
        "focusedElementRole": focused_role,
        "focusedElementValue": focused_value,
    });

    println!("{}", serde_json::to_string(&output).unwrap());
}
