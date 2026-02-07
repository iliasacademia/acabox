mod desired_state;
mod manager;
mod panel;
mod responses;
mod webview;

use desired_state::DesiredState;
use manager::Manager;

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

    // Init NSApplication as Accessory (no dock icon, no menu bar)
    let mtm = {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
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

    // Main loop: drive CFRunLoop + drain desired state channel
    while !should_exit.load(Ordering::Relaxed) {
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                RUNLOOP_TIMEOUT_SECS,
                1, // returnAfterSourceHandled
            );
        }

        // Drain all pending states — only the last one matters
        let mut latest_state: Option<DesiredState> = None;
        while let Ok(state) = rx.try_recv() {
            latest_state = Some(state);
        }

        if let Some(desired) = latest_state {
            manager.reconcile(&desired);
        }
    }

    eprintln!("webview-manager: shutting down");
}
