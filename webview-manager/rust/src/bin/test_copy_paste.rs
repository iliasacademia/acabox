//! Test binary to isolate Cmd+C/V copy/paste in non-activating NSPanel + WKWebView.
//!
//! Tests whether adding a standard Edit NSMenu makes performKeyEquivalent work
//! end-to-end (menu dispatch → copy:/paste: on first responder).

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSEvent, NSEventModifierFlags, NSEventType,
    NSMenu, NSMenuItem, NSPasteboard, NSPasteboardTypeString,
};
use objc2_foundation::{NSDefaultRunLoopMode, NSError, NSPoint, NSRect, NSSize, NSString};
use objc2_web_kit::WKWebView;

use std::sync::{Arc, Mutex};

use webview_manager::debug;
use webview_manager::panel::{self, KeyablePanel};
use webview_manager::webview;

const VK_ANSI_C: u16 = 8;
const VK_ANSI_V: u16 = 9;

fn spin_runloop(app: &NSApplication, seconds: f64) {
    let start = std::time::Instant::now();
    let duration = std::time::Duration::from_secs_f64(seconds);
    while start.elapsed() < duration {
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                0.01,
                1,
            );
        }
        loop {
            let mode = unsafe { &NSDefaultRunLoopMode };
            let event = app.nextEventMatchingMask_untilDate_inMode_dequeue(
                objc2_app_kit::NSEventMask::Any,
                None,
                mode,
                true,
            );
            match event {
                Some(ev) => app.sendEvent(&ev),
                None => break,
            }
        }
    }
}

fn eval_js_sync(
    webview: &WKWebView,
    app: &NSApplication,
    js: &str,
) -> Option<String> {
    let result: Arc<Mutex<Option<Result<String, String>>>> = Arc::new(Mutex::new(None));
    let result_clone = Arc::clone(&result);

    let js_string = NSString::from_str(js);

    let block = block2::RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
        let mut guard = result_clone.lock().unwrap();
        if !error.is_null() {
            let err_desc: Retained<NSString> =
                unsafe { msg_send![error, localizedDescription] };
            *guard = Some(Err(err_desc.to_string()));
        } else if !value.is_null() {
            let desc: Retained<NSString> = unsafe { msg_send![value, description] };
            *guard = Some(Ok(desc.to_string()));
        } else {
            *guard = Some(Ok(String::new()));
        }
    });

    unsafe {
        webview.evaluateJavaScript_completionHandler(&js_string, Some(&block));
    }

    let start = std::time::Instant::now();
    loop {
        spin_runloop(app, 0.05);
        if let Ok(guard) = result.lock() {
            if guard.is_some() {
                break;
            }
        }
        if start.elapsed() > std::time::Duration::from_secs(5) {
            eprintln!("[test] JS evaluation timed out for: {}", js);
            return None;
        }
    }

    let taken = result.lock().unwrap().take();
    match taken {
        Some(Ok(s)) => Some(s),
        Some(Err(e)) => {
            eprintln!("[test] JS error: {}", e);
            None
        }
        None => None,
    }
}

fn get_pasteboard_string() -> Option<String> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let pb_string: Option<Retained<NSString>> = unsafe {
        pasteboard.stringForType(NSPasteboardTypeString)
    };
    pb_string.as_ref().map(|s| s.to_string())
}

fn clear_pasteboard() {
    NSPasteboard::generalPasteboard().clearContents();
}

/// Create a standard Edit menu with Copy, Paste, Cut, Select All, Undo, Redo.
fn create_edit_menu(mtm: MainThreadMarker) {
    let menu_bar = NSMenu::new(mtm);

    // App menu (required as first item)
    let app_menu_item = NSMenuItem::new(mtm);
    let app_menu = NSMenu::new(mtm);
    app_menu_item.setSubmenu(Some(&app_menu));
    menu_bar.addItem(&app_menu_item);

    // Edit menu
    let edit_menu_item = NSMenuItem::new(mtm);
    let edit_menu = NSMenu::initWithTitle(mtm.alloc(), &NSString::from_str("Edit"));

    // Undo — Cmd+Z
    let undo_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("Undo"),
            Some(sel!(undo:)),
            &NSString::from_str("z"),
        )
    };
    edit_menu.addItem(&undo_item);

    // Redo — Cmd+Shift+Z
    let redo_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("Redo"),
            Some(sel!(redo:)),
            &NSString::from_str("Z"),
        )
    };
    edit_menu.addItem(&redo_item);

    // Separator
    edit_menu.addItem(&NSMenuItem::separatorItem(mtm));

    // Cut — Cmd+X
    let cut_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("Cut"),
            Some(sel!(cut:)),
            &NSString::from_str("x"),
        )
    };
    edit_menu.addItem(&cut_item);

    // Copy — Cmd+C
    let copy_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("Copy"),
            Some(sel!(copy:)),
            &NSString::from_str("c"),
        )
    };
    edit_menu.addItem(&copy_item);

    // Paste — Cmd+V
    let paste_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("Paste"),
            Some(sel!(paste:)),
            &NSString::from_str("v"),
        )
    };
    edit_menu.addItem(&paste_item);

    // Select All — Cmd+A
    let select_all_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("Select All"),
            Some(sel!(selectAll:)),
            &NSString::from_str("a"),
        )
    };
    edit_menu.addItem(&select_all_item);

    edit_menu_item.setSubmenu(Some(&edit_menu));
    menu_bar.addItem(&edit_menu_item);

    let app = NSApplication::sharedApplication(mtm);
    app.setMainMenu(Some(&menu_bar));
    eprintln!("[test] Edit menu installed");
}

fn select_input1(wv: &WKWebView, app: &NSApplication) {
    eval_js_sync(wv, app,
        "var inp = document.getElementById('input1'); inp.value = 'HELLO_COPY_TEST'; inp.focus(); inp.select(); 'ok'");
    spin_runloop(app, 0.3);
}

fn send_synthetic_cmd_key(panel: &KeyablePanel, key_code: u16, character: &str) -> bool {
    let chars = NSString::from_str(character);
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags::Command,
        0.0,
        panel.windowNumber(),
        None,
        &chars,
        &chars,
        false,
        key_code,
    ).expect("Failed to create NSEvent");

    let result: Bool = unsafe { msg_send![&**panel, performKeyEquivalent: &*event] };
    result.as_bool()
}

fn main() {
    std::env::set_var("WEBVIEW_MANAGER_DEBUG_LOG",
        std::env::var("WEBVIEW_MANAGER_DEBUG_LOG")
            .unwrap_or_else(|_| "/tmp/webview-debug.log".to_string()));
    debug::init();

    eprintln!("[test] === Copy/Paste Test: NSMenu Approach ===\n");

    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();
    eprintln!("[test] NSApp initialized (Accessory policy)");

    // Create panel + webview
    let frame = NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(400.0, 300.0));
    let panel = panel::create_panel(mtm, frame, false);
    let wv = webview::create_webview(mtm, &panel, "about:blank")
        .expect("Failed to create webview");

    let html = NSString::from_str(r#"<!DOCTYPE html>
<html>
<body style="background: white; padding: 20px;">
    <h3>Copy/Paste Test</h3>
    <input type="text" id="input1" style="font-size: 18px; padding: 8px; width: 300px;"><br><br>
    <input type="text" id="input2" style="font-size: 18px; padding: 8px; width: 300px;">
</body>
</html>"#);
    unsafe {
        let _: *mut NSObject = msg_send![&wv, loadHTMLString: &*html, baseURL: std::ptr::null::<NSObject>()];
    }

    panel.orderFrontRegardless();
    panel.makeKeyWindow();
    eprintln!("[test] Panel isKeyWindow={}", panel.isKeyWindow());

    eprintln!("[test] Waiting 3s for page load...");
    spin_runloop(&app, 3.0);

    // ========================================
    // TEST A: WITHOUT Edit menu (baseline — should fail)
    // ========================================
    eprintln!("--- TEST A: performKeyEquivalent WITHOUT Edit menu ---");
    select_input1(&wv, &app);
    clear_pasteboard();

    let handled = send_synthetic_cmd_key(&panel, VK_ANSI_C, "c");
    spin_runloop(&app, 1.0);
    let result_a = get_pasteboard_string();
    eprintln!("[test] performKeyEquivalent → {}, pasteboard: {:?}", handled, result_a);
    let pass_a = result_a.as_deref() == Some("HELLO_COPY_TEST");
    eprintln!("{} A (no menu)\n", if pass_a { "PASS" } else { "FAIL" });

    // ========================================
    // Install Edit menu
    // ========================================
    create_edit_menu(mtm);

    // ========================================
    // TEST B: WITH Edit menu, performKeyEquivalent on panel
    // ========================================
    eprintln!("--- TEST B: performKeyEquivalent WITH Edit menu ---");
    select_input1(&wv, &app);
    clear_pasteboard();

    let handled = send_synthetic_cmd_key(&panel, VK_ANSI_C, "c");
    spin_runloop(&app, 1.0);
    let result_b = get_pasteboard_string();
    eprintln!("[test] performKeyEquivalent → {}, pasteboard: {:?}", handled, result_b);
    let pass_b = result_b.as_deref() == Some("HELLO_COPY_TEST");
    eprintln!("{} B (menu + performKeyEquivalent)\n", if pass_b { "PASS" } else { "FAIL" });

    // ========================================
    // TEST C: WITH Edit menu, send event via NSApp.sendEvent
    // ========================================
    eprintln!("--- TEST C: NSApp.sendEvent WITH Edit menu ---");
    select_input1(&wv, &app);
    clear_pasteboard();

    let chars = NSString::from_str("c");
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags::Command,
        0.0,
        panel.windowNumber(),
        None,
        &chars,
        &chars,
        false,
        VK_ANSI_C,
    ).expect("Failed to create NSEvent");
    app.sendEvent(&event);

    spin_runloop(&app, 1.0);
    let result_c = get_pasteboard_string();
    eprintln!("[test] pasteboard: {:?}", result_c);
    let pass_c = result_c.as_deref() == Some("HELLO_COPY_TEST");
    eprintln!("{} C (menu + sendEvent)\n", if pass_c { "PASS" } else { "FAIL" });

    // ========================================
    // TEST D: Full copy+paste cycle with Edit menu via sendAction
    // ========================================
    eprintln!("--- TEST D: Full copy+paste cycle (sendAction with menu installed) ---");
    select_input1(&wv, &app);
    clear_pasteboard();

    // Copy
    let copy_ok: Bool = unsafe {
        msg_send![&*app, sendAction: sel!(copy:), to: std::ptr::null::<AnyObject>(), from: std::ptr::null::<AnyObject>()]
    };
    spin_runloop(&app, 0.5);
    let copied = get_pasteboard_string();
    eprintln!("[test] sendAction:copy: → {}, pasteboard: {:?}", copy_ok.as_bool(), copied);

    // Focus input2 and paste
    eval_js_sync(&wv, &app, "document.getElementById('input2').focus(); 'ok'");
    spin_runloop(&app, 0.3);

    let paste_ok: Bool = unsafe {
        msg_send![&*app, sendAction: sel!(paste:), to: std::ptr::null::<AnyObject>(), from: std::ptr::null::<AnyObject>()]
    };
    spin_runloop(&app, 0.5);
    let pasted = eval_js_sync(&wv, &app, "document.getElementById('input2').value");
    eprintln!("[test] sendAction:paste: → {}, input2.value: {:?}", paste_ok.as_bool(), pasted);
    let pass_d = pasted.as_deref() == Some("HELLO_COPY_TEST");
    eprintln!("{} D (full copy+paste via sendAction)\n", if pass_d { "PASS" } else { "FAIL" });

    // ========================================
    // TEST E: WITH Edit menu, send Cmd+V via sendEvent to paste
    // ========================================
    eprintln!("--- TEST E: Full copy(sendAction)+paste(sendEvent) with Edit menu ---");
    // input2 should already have text, clear it
    eval_js_sync(&wv, &app, "var inp2 = document.getElementById('input2'); inp2.value = ''; inp2.focus(); 'ok'");
    spin_runloop(&app, 0.3);

    let chars_v = NSString::from_str("v");
    let paste_event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags::Command,
        0.0,
        panel.windowNumber(),
        None,
        &chars_v,
        &chars_v,
        false,
        VK_ANSI_V,
    ).expect("Failed to create NSEvent");
    app.sendEvent(&paste_event);
    spin_runloop(&app, 1.0);
    let pasted_e = eval_js_sync(&wv, &app, "document.getElementById('input2').value");
    eprintln!("[test] input2.value after Cmd+V sendEvent: {:?}", pasted_e);
    let pass_e = pasted_e.as_deref() == Some("HELLO_COPY_TEST");
    eprintln!("{} E (paste via sendEvent)\n", if pass_e { "PASS" } else { "FAIL" });

    // Summary
    eprintln!("=== RESULTS ===");
    eprintln!("A (no menu, performKeyEquivalent): {}", if pass_a { "PASS" } else { "FAIL" });
    eprintln!("B (menu, performKeyEquivalent):    {}", if pass_b { "PASS" } else { "FAIL" });
    eprintln!("C (menu, sendEvent):               {}", if pass_c { "PASS" } else { "FAIL" });
    eprintln!("D (menu, sendAction copy+paste):   {}", if pass_d { "PASS" } else { "FAIL" });
    eprintln!("E (menu, sendEvent paste):         {}", if pass_e { "PASS" } else { "FAIL" });

    let all_relevant_pass = pass_b || pass_c || pass_d || pass_e;
    if all_relevant_pass {
        eprintln!("\nAt least one menu-based approach works!");
    }

    std::process::exit(if pass_d { 0 } else { 1 });
}
