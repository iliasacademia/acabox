use clap::Parser;
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::flag;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use window_monitor_lib::accessibility;
use window_monitor_lib::window_monitor;

const POLL_INTERVAL_MS: u128 = 200;
const RUNLOOP_TIMEOUT_SECS: f64 = 0.1;

/// Monitor window events for a macOS application and output JSON to stdout.
#[derive(Parser)]
#[command(name = "window-monitor")]
#[command(about = "Monitors window events for the specified app and outputs JSON to stdout.")]
#[command(after_help = "\
Examples:
  window-monitor                                    # Monitor Microsoft Word (default)
  window-monitor --bundle-id com.apple.Preview      # Monitor Preview
  window-monitor -b com.microsoft.Powerpoint        # Monitor PowerPoint

Description:
  Monitors window events for the specified app and outputs JSON to stdout.
  Press Ctrl+C to stop monitoring.

Requirements:
  - Accessibility permissions must be granted
  - System Preferences > Privacy & Security > Accessibility

Output format:
  One JSON object per line for each window event.
  Events: APP_EXISTING, APP_LAUNCHED, APP_TERMINATED, APP_FOCUSED, APP_UNFOCUSED,
          WINDOW_EXISTING, WINDOW_CREATED, WINDOW_DESTROYED, WINDOW_FOCUSED,
          WINDOW_REPOSITIONING, WINDOW_REPOSITIONED, WINDOW_DOCUMENT_PATH_CHANGED,
          WINDOW_TEXT_SELECTED, WINDOW_TEXT_SELECTION_CLEARED,
          WINDOW_TEXT_SELECTION_REPOSITIONING, WINDOW_TEXT_SELECTION_REPOSITIONED,
          WINDOW_DOCUMENT_TEXT_CHANGED")]
struct Cli {
    /// Bundle ID of the app to monitor
    #[arg(short = 'b', long = "bundle-id", default_value = "com.microsoft.Word")]
    bundle_id: String,

    /// Track text selection changes in the focused UI element
    #[arg(long = "track-text-selection")]
    track_text_selection: bool,

    /// Track document text changes (polls character count, debounces, writes to file)
    #[arg(long = "track-document-text")]
    track_document_text: bool,
}

fn main() {
    let cli = Cli::parse();

    // Set up signal handling
    let should_exit = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&should_exit)).expect("Failed to register SIGINT handler");
    flag::register(SIGTERM, Arc::clone(&should_exit)).expect("Failed to register SIGTERM handler");

    // Check accessibility permissions
    if !accessibility::is_process_trusted() {
        eprintln!("ERROR: Accessibility permissions not granted.");
        eprintln!("Please grant accessibility permissions in:");
        eprintln!("  System Preferences > Privacy & Security > Accessibility");
        eprintln!();
        eprintln!("Opening System Preferences...");
        accessibility::request_accessibility_permission();
        std::process::exit(1);
    }

    eprintln!("Window Monitor for {}", cli.bundle_id);
    if cli.track_text_selection {
        eprintln!("Text selection tracking: enabled");
    }
    if cli.track_document_text {
        eprintln!("Document text tracking: enabled");
    }
    eprintln!("Press Ctrl+C to stop monitoring");
    eprintln!("---");

    // Initialize NSApplication (required for NSWorkspace notifications)
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        // We're on the main thread at program start
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let _ = NSApplication::sharedApplication(mtm);
    }

    // Use system temp dir for file-based text output
    let temp_dir = std::env::temp_dir();

    // Create monitor and start monitoring
    let mut monitor = Box::new(window_monitor::WindowMonitor::new(
        &cli.bundle_id,
        cli.track_text_selection,
        cli.track_document_text,
        temp_dir,
    ));
    let monitor_ptr: *mut window_monitor::WindowMonitor = &mut *monitor;
    monitor.start_monitoring(monitor_ptr, &should_exit);

    eprintln!("Monitoring started. Waiting for window events...");

    // Main loop: drive CFRunLoop and check timers
    let mut last_poll = Instant::now();

    while !should_exit.load(Ordering::Relaxed) {
        // Process events for 100ms (handles AX callbacks + NSWorkspace notifications)
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                RUNLOOP_TIMEOUT_SECS,
                1, // returnAfterSourceHandled = true
            );
        }

        // 150ms debounce: check if resize/move is finished (before polling can reset timer)
        monitor.check_resize_end();
        monitor.check_selection_bounds_end();

        // 200ms polling: check for missed events
        if last_poll.elapsed().as_millis() >= POLL_INTERVAL_MS {
            monitor.poll_for_changes();
            last_poll = Instant::now();
        }

        // 100ms deferred: check for window changes after AX notification
        monitor.check_deferred_window_check();
    }

    // Clean up
    monitor.stop_monitoring();
    eprintln!("Monitor stopped.");
}
