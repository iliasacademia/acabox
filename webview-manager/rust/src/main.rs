mod desired_state;
mod manager;
mod responses;

use webview_manager::debug;

use desired_state::DesiredState;
use manager::Manager;

use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSEventMask, NSMenu, NSMenuItem};
use objc2_foundation::{NSDefaultRunLoopMode, NSString};
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::flag;
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};

const RUNLOOP_TIMEOUT_SECS: f64 = 0.05; // 50ms

/// Webview Manager — reads desired state JSON from stdin, reconciles webview windows.
fn main() {
    // Signal handling
    let should_exit = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&should_exit)).expect("Failed to register SIGINT handler");
    flag::register(SIGTERM, Arc::clone(&should_exit)).expect("Failed to register SIGTERM handler");

    // Debug file logging (enabled by WEBVIEW_MANAGER_DEBUG_LOG env var)
    debug::init();

    // Init NSApplication as Accessory (no dock icon, no menu bar)
    let mtm = {
        use objc2::MainThreadMarker;
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

        // Install a standard Edit menu so that Cmd+C/V/X/A/Z are routed as
        // copy:/paste:/cut:/selectAll:/undo:/redo: actions through the responder
        // chain.  Without this menu, WKWebView in a non-activating panel
        // silently drops clipboard shortcuts.
        install_edit_menu(mtm, &app);

        // finishLaunching sets up event infrastructure (window server registration, etc.)
        app.finishLaunching();
        mtm
    };

    eprintln!("webview-manager: ready");

    // Channel for stdin desired states → main thread
    let (tx, rx) = mpsc::channel::<DesiredState>();
    let exit_flag = Arc::clone(&should_exit);

    // Background thread: read stdin line-by-line
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let reader = stdin.lock();
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let text = text.trim().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<DesiredState>(&text) {
                        Ok(state) => {
                            if tx.send(state).is_err() {
                                break; // main thread gone
                            }
                        }
                        Err(e) => {
                            eprintln!("webview-manager: parse error: {e} — input: {text}");
                        }
                    }
                }
                Err(_) => break, // stdin closed
            }
        }
        // stdin EOF → signal exit
        exit_flag.store(true, Ordering::Relaxed);
    });

    // Manager holds all webview state
    let mut manager = Manager::new(mtm);

    // Keep a reference for event dispatching
    let app = NSApplication::sharedApplication(mtm);

    // Main loop: drive CFRunLoop + drain desired state channel
    while !should_exit.load(Ordering::Relaxed) {
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                RUNLOOP_TIMEOUT_SECS,
                1, // returnAfterSourceHandled
            );
        }

        // Process pending NSApplication events (mouse clicks, key events, etc.)
        loop {
            let mode = unsafe { &NSDefaultRunLoopMode };
            let event = app.nextEventMatchingMask_untilDate_inMode_dequeue(
                NSEventMask::Any,
                None,
                mode,
                true,
            );
            match event {
                Some(ev) => app.sendEvent(&ev),
                None => break,
            }
        }

        // Drain all pending states — only the last one matters
        let mut latest_state: Option<DesiredState> = None;
        while let Ok(state) = rx.try_recv() {
            latest_state = Some(state);
        }

        if let Some(desired) = latest_state {
            debug::debug_log!("main: received desired state with {} entries", desired.len());
            manager.reconcile(&desired);
        }
    }

    eprintln!("webview-manager: shutting down");
}

/// Install a main menu with a standard Edit submenu.
///
/// macOS dispatches Cmd+key events through the menu system, which translates
/// key equivalents into responder-chain actions (copy:, paste:, etc.).
/// An Accessory-policy app has no menu bar, but the dispatch still works
/// internally — this is what makes Cmd+C/V work in WKWebView panels.
fn install_edit_menu(mtm: objc2::MainThreadMarker, app: &NSApplication) {
    use objc2::sel;

    let menu_bar = NSMenu::new(mtm);

    // App menu (required as first item)
    let app_item = NSMenuItem::new(mtm);
    app_item.setSubmenu(Some(&NSMenu::new(mtm)));
    menu_bar.addItem(&app_item);

    // Edit menu
    let edit_item = NSMenuItem::new(mtm);
    let edit_menu = NSMenu::initWithTitle(mtm.alloc(), &NSString::from_str("Edit"));

    let items: &[(&str, objc2::runtime::Sel, &str)] = &[
        ("Undo",       sel!(undo:),      "z"),
        ("Redo",       sel!(redo:),      "Z"), // Shift implied by uppercase
        ("Cut",        sel!(cut:),       "x"),
        ("Copy",       sel!(copy:),      "c"),
        ("Paste",      sel!(paste:),     "v"),
        ("Select All", sel!(selectAll:), "a"),
    ];

    for &(title, action, key) in items {
        let mi = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                mtm.alloc(),
                &NSString::from_str(title),
                Some(action),
                &NSString::from_str(key),
            )
        };
        edit_menu.addItem(&mi);
    }

    edit_item.setSubmenu(Some(&edit_menu));
    menu_bar.addItem(&edit_item);
    app.setMainMenu(Some(&menu_bar));
}
