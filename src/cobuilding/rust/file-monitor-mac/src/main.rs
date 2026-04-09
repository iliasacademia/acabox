mod accessibility;
mod events;
mod workspace;

use accessibility::{SafeAXObserver, SafeAXUIElement};
use clap::Parser;
use core_foundation::base::TCFType;
use core_foundation::runloop::CFRunLoop;
use events::{AppInfo, EventType, FileMonitorEvent, WindowInfo};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const RUNLOOP_TIMEOUT_SECS: f64 = 0.1;

const TARGET_BUNDLE_IDS: &[&str] = &[
    "com.microsoft.Word",
    "com.microsoft.Excel",
    "com.microsoft.Powerpoint",
    "com.apple.Preview",
];

fn is_target_app(bundle_id: &str) -> bool {
    TARGET_BUNDLE_IDS.contains(&bundle_id)
}

#[derive(Parser)]
#[command(name = "file-monitor-mac")]
#[command(about = "Monitors open document file URLs for Office and Preview apps")]
struct Cli {
    /// Poll interval in seconds
    #[arg(short = 'i', long = "interval", default_value = "10")]
    interval: u64,
}

// --- Event queue for cross-callback communication ---

#[derive(Debug)]
enum IncomingEvent {
    AppActivated {
        pid: i32,
        name: String,
        bundle_id: String,
    },
    AppDeactivated {
        bundle_id: String,
    },
    FocusedWindowChanged,
    TitleChanged,
}

type EventQueue = Arc<Mutex<Vec<IncomingEvent>>>;

static EVENT_QUEUE: OnceLock<EventQueue> = OnceLock::new();

fn get_event_queue() -> &'static EventQueue {
    EVENT_QUEUE.get_or_init(|| Arc::new(Mutex::new(Vec::new())))
}

// --- Monitor state ---

struct ActiveApp {
    pid: i32,
    name: String,
    bundle_id: String,
}

struct MonitorState {
    active_app: Option<ActiveApp>,
    app_element: Option<SafeAXUIElement>,
    ax_observer: Option<SafeAXObserver>,
    runloop_source: Option<core_foundation::runloop::CFRunLoopSource>,
    last_focused_window_id: Option<u32>,
    last_window_info: WindowInfo,
}

impl MonitorState {
    fn new() -> Self {
        MonitorState {
            active_app: None,
            app_element: None,
            ax_observer: None,
            runloop_source: None,
            last_focused_window_id: None,
            last_window_info: WindowInfo {
                id: None,
                title: None,
                document_url: None,
            },
        }
    }

    fn read_current_window(&self) -> WindowInfo {
        let app_element = match self.app_element.as_ref() {
            Some(el) => el,
            None => {
                return WindowInfo {
                    id: None,
                    title: None,
                    document_url: None,
                }
            }
        };

        let focused = accessibility::get_focused_window(app_element);
        match focused {
            Some(window) => {
                let id = accessibility::get_window_id(&window);
                let title = accessibility::get_title(&window);
                let document_url = accessibility::get_document(&window);
                WindowInfo {
                    id,
                    title,
                    document_url,
                }
            }
            None => WindowInfo {
                id: None,
                title: None,
                document_url: None,
            },
        }
    }

    fn app_info(&self) -> Option<AppInfo> {
        self.active_app.as_ref().map(|app| AppInfo {
            name: app.name.clone(),
            bundle_id: app.bundle_id.clone(),
            pid: app.pid,
        })
    }

    fn emit(&self, event_type: EventType, window: WindowInfo) {
        if let Some(app) = self.app_info() {
            let event = FileMonitorEvent {
                event: event_type,
                timestamp: events::now_timestamp(),
                platform: "macos",
                app,
                window,
            };
            events::emit_event(&event);
        }
    }

    fn attach_to_app(&mut self, pid: i32, name: String, bundle_id: String) {
        // Detach from previous app first
        self.detach_from_app();

        self.active_app = Some(ActiveApp {
            pid,
            name,
            bundle_id,
        });

        let app_element = match accessibility::create_app_element(pid) {
            Some(el) => el,
            None => {
                eprintln!("Failed to create AXUIElement for pid {}", pid);
                return;
            }
        };

        let observer = match accessibility::create_observer(pid, ax_observer_callback) {
            Some(obs) => obs,
            None => {
                eprintln!("Failed to create AXObserver for pid {}", pid);
                self.app_element = Some(app_element);
                return;
            }
        };

        // Use a null context — the callback uses the global EVENT_QUEUE instead
        let context = std::ptr::null_mut();

        observer.add_notification(
            &app_element,
            accessibility::k_ax_focused_window_changed_notification(),
            context,
        );
        observer.add_notification(
            &app_element,
            accessibility::k_ax_window_created_notification(),
            context,
        );
        observer.add_notification(
            &app_element,
            accessibility::k_ax_ui_element_destroyed_notification(),
            context,
        );
        observer.add_notification(
            &app_element,
            accessibility::k_ax_title_changed_notification(),
            context,
        );

        // Add observer's run loop source to the current CFRunLoop
        if let Some(source) = observer.get_runloop_source() {
            let run_loop = CFRunLoop::get_current();
            unsafe {
                core_foundation::runloop::CFRunLoopAddSource(
                    run_loop.as_concrete_TypeRef(),
                    source.as_concrete_TypeRef(),
                    core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                );
            }
            self.runloop_source = Some(source);
        }

        self.app_element = Some(app_element);
        self.ax_observer = Some(observer);

        // Read initial window state
        let window = self.read_current_window();
        self.last_focused_window_id = window.id;
        self.last_window_info = window.clone();

        // Emit APP_FOCUSED
        self.emit(EventType::AppFocused, window.clone());

        // Emit initial WINDOW_FOCUSED if we have a window
        if window.id.is_some() {
            self.emit(EventType::WindowFocused, window);
        }
    }

    fn detach_from_app(&mut self) {
        // Remove run loop source
        if let Some(ref source) = self.runloop_source {
            let run_loop = CFRunLoop::get_current();
            unsafe {
                core_foundation::runloop::CFRunLoopRemoveSource(
                    run_loop.as_concrete_TypeRef(),
                    source.as_concrete_TypeRef(),
                    core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                );
            }
        }
        self.runloop_source = None;
        self.ax_observer = None;
        self.app_element = None;
        self.active_app = None;
        self.last_focused_window_id = None;
        self.last_window_info = WindowInfo {
            id: None,
            title: None,
            document_url: None,
        };
    }

    fn handle_focus_change(&mut self) {
        let window = self.read_current_window();
        if window.id != self.last_focused_window_id {
            self.last_focused_window_id = window.id;
            self.last_window_info = window.clone();
            self.emit(EventType::WindowFocused, window);
        }
    }

    fn handle_title_change(&mut self) {
        let window = self.read_current_window();
        self.last_window_info = window;
    }

    fn poll_and_emit(&mut self) {
        let window = self.read_current_window();
        // Check for focus change that may have been missed
        if window.id != self.last_focused_window_id {
            self.last_focused_window_id = window.id;
            self.last_window_info = window.clone();
            self.emit(EventType::WindowFocused, window.clone());
        } else {
            self.last_window_info = window.clone();
        }
        self.emit(EventType::FileMonitorPoll, window);
    }
}

// --- AX Observer callback ---

unsafe extern "C" fn ax_observer_callback(
    _observer: accessibility::AXObserverRef,
    _element: accessibility::AXUIElementRef,
    notification_name: core_foundation_sys::string::CFStringRef,
    _context: *mut c_void,
) {
    let notif: core_foundation::string::CFString =
        TCFType::wrap_under_get_rule(notification_name);
    let notif_str = notif.to_string();

    let event = match notif_str.as_str() {
        "AXFocusedWindowChanged" | "AXWindowCreated" | "AXUIElementDestroyed" => {
            IncomingEvent::FocusedWindowChanged
        }
        "AXTitleChanged" => IncomingEvent::TitleChanged,
        _ => return,
    };

    if let Ok(mut queue) = get_event_queue().lock() {
        queue.push(event);
    }
}

fn main() {
    let cli = Cli::parse();
    let poll_interval = Duration::from_secs(cli.interval);

    // Check accessibility permission
    if !accessibility::is_process_trusted() {
        eprintln!("Accessibility permission required.");
        eprintln!("Please enable in System Settings > Privacy & Security > Accessibility");
        accessibility::request_accessibility_permission();
        std::process::exit(1);
    }

    // Set up signal handling
    let should_exit = Arc::new(AtomicBool::new(false));
    {
        let exit_flag = Arc::clone(&should_exit);
        signal_hook::flag::register(signal_hook::consts::SIGINT, exit_flag)
            .expect("Failed to register SIGINT handler");
    }
    {
        let exit_flag = Arc::clone(&should_exit);
        signal_hook::flag::register(signal_hook::consts::SIGTERM, exit_flag)
            .expect("Failed to register SIGTERM handler");
    }

    // Initialize event queue
    let _ = get_event_queue();

    // Register workspace notifications
    let workspace_callback = {
        let queue = get_event_queue().clone();
        Arc::new(Mutex::new(
            move |notif: workspace::WorkspaceNotification| {
                let event = match notif.event {
                    workspace::WorkspaceEvent::AppActivated => {
                        let bundle_id = match notif.bundle_id {
                            Some(bid) => bid,
                            None => return,
                        };
                        let name = notif.app_name.unwrap_or_else(|| bundle_id.clone());
                        IncomingEvent::AppActivated {
                            pid: notif.pid,
                            name,
                            bundle_id,
                        }
                    }
                    workspace::WorkspaceEvent::AppDeactivated => {
                        let bundle_id = match notif.bundle_id {
                            Some(bid) => bid,
                            None => return,
                        };
                        IncomingEvent::AppDeactivated { bundle_id }
                    }
                };
                if let Ok(mut q) = queue.lock() {
                    q.push(event);
                }
            },
        ))
    };

    let _workspace_tokens = workspace::register_workspace_notifications(workspace_callback);

    let mut state = MonitorState::new();

    // Check if current frontmost app is a target
    if let Some((pid, name, bid)) = workspace::get_frontmost_app() {
        if is_target_app(&bid) {
            eprintln!("Attaching to frontmost app: {} ({})", name, bid);
            state.attach_to_app(pid, name, bid);
        }
    }

    eprintln!(
        "file-monitor-mac running (poll interval: {}s). Press Ctrl+C to stop.",
        cli.interval
    );

    let mut last_poll = Instant::now();

    // Main event loop
    while !should_exit.load(Ordering::Relaxed) {
        // Drive CFRunLoop — processes AX observer callbacks + workspace notifications
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                RUNLOOP_TIMEOUT_SECS,
                1, // returnAfterSourceHandled = true
            );
        }

        // Drain event queue
        let events: Vec<IncomingEvent> = {
            match get_event_queue().lock() {
                Ok(mut q) => q.drain(..).collect(),
                Err(_) => Vec::new(),
            }
        };

        for event in events {
            match event {
                IncomingEvent::AppActivated {
                    pid,
                    name,
                    bundle_id,
                } => {
                    if is_target_app(&bundle_id) {
                        // Emit APP_UNFOCUSED for previous app if there was one
                        if state.active_app.is_some() {
                            let window = state.last_window_info.clone();
                            state.emit(EventType::AppUnfocused, window);
                        }
                        eprintln!("Target app activated: {} ({})", name, bundle_id);
                        state.attach_to_app(pid, name, bundle_id);
                        last_poll = Instant::now();
                    } else if state.active_app.is_some() {
                        // Non-target app activated — unfocus current target
                        let window = state.last_window_info.clone();
                        state.emit(EventType::AppUnfocused, window);
                        state.detach_from_app();
                    }
                }
                IncomingEvent::AppDeactivated { bundle_id } => {
                    if let Some(ref app) = state.active_app {
                        if app.bundle_id == bundle_id {
                            let window = state.last_window_info.clone();
                            state.emit(EventType::AppUnfocused, window);
                            state.detach_from_app();
                        }
                    }
                }
                IncomingEvent::FocusedWindowChanged => {
                    if state.active_app.is_some() {
                        state.handle_focus_change();
                    }
                }
                IncomingEvent::TitleChanged => {
                    if state.active_app.is_some() {
                        state.handle_title_change();
                    }
                }
            }
        }

        // Periodic poll
        if state.active_app.is_some() && last_poll.elapsed() >= poll_interval {
            state.poll_and_emit();
            last_poll = Instant::now();
        }
    }

    eprintln!("Shutting down...");
    if state.active_app.is_some() {
        let window = state.last_window_info.clone();
        state.emit(EventType::AppUnfocused, window);
        state.detach_from_app();
    }
}
