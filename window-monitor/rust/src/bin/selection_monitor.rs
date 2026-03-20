use clap::Parser;
use serde::Serialize;
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::flag;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use window_monitor_lib::accessibility;
use window_monitor_lib::workspace::{
    self, WorkspaceEvent, WorkspaceNotification, WorkspaceObserverTokens,
};

#[derive(Parser)]
#[command(name = "selection-monitor")]
struct Args {
    /// Local HTTP server port
    #[arg(long, default_value = "23111")]
    port: u16,

    /// Bearer token for authentication
    #[arg(long)]
    auth_token: Option<String>,

    /// Demo mode: human-friendly colored output instead of JSON
    #[arg(long)]
    demo: bool,
}

const MAX_TEXT_LENGTH: usize = 10_000;
const POLL_INTERVAL_MS: u128 = 200;
const RUNLOOP_TIMEOUT_SECS: f64 = 0.1;

// ANSI escape codes
const BLUE: &str = "\x1b[34m";
const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

// --- Output JSON models ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: String,
    bundle_id: String,
    pid: i32,
}

#[derive(Debug, Clone, Serialize)]
struct WindowInfo {
    id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionEvent {
    event: String,
    timestamp: String,
    app: AppInfo,
    window: WindowInfo,
    selected_text: String,
    length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
}

// --- Focused app state ---

struct FocusedApp {
    info: AppInfo,
    ax_element: accessibility::SafeAXUIElement,
}

// --- Monitor state ---

struct SelectionMonitor {
    focused_app: Option<FocusedApp>,
    last_emitted_text: Arc<Mutex<Option<String>>>,
    demo: bool,
}

impl SelectionMonitor {
    fn new(last_emitted_text: Arc<Mutex<Option<String>>>, demo: bool) -> Self {
        Self {
            focused_app: None,
            last_emitted_text,
            demo,
        }
    }

    fn set_focused_app(&mut self, name: String, bundle_id: String, pid: i32) {
        if pid <= 0 {
            self.focused_app = None;
            return;
        }
        if let Some(ax) = accessibility::create_app_element(pid) {
            self.focused_app = Some(FocusedApp {
                info: AppInfo {
                    name,
                    bundle_id,
                    pid,
                },
                ax_element: ax,
            });
        } else {
            self.focused_app = None;
        }
    }

    fn poll(&mut self) {
        let app = match &self.focused_app {
            Some(a) => a,
            None => return,
        };

        let focused_el = match accessibility::get_focused_ui_element(&app.ax_element) {
            Some(el) => el,
            None => return,
        };

        let text = match accessibility::get_selected_text(&focused_el) {
            Some(t) if !t.is_empty() => t,
            _ => return,
        };

        // Dedup: skip if same as last emitted
        if let Ok(last) = self.last_emitted_text.lock() {
            if let Some(ref prev) = *last {
                if *prev == text {
                    return;
                }
            }
        }

        // Get window info
        let window_id = accessibility::get_focused_window(&app.ax_element)
            .and_then(|w| accessibility::get_window_id(&w))
            .map(|id| id.to_string())
            .unwrap_or_default();

        let actual_length = text.len();
        let (output_text, truncated) = if actual_length > MAX_TEXT_LENGTH {
            // Truncate at char boundary
            let truncated_text: String = text.chars().take(MAX_TEXT_LENGTH).collect();
            (truncated_text, Some(true))
        } else {
            (text.clone(), None)
        };

        // Use char count for length (matches what users expect)
        let char_length = text.chars().count();
        let output_char_length = if truncated.is_some() {
            char_length
        } else {
            char_length
        };

        let event = SelectionEvent {
            event: "TEXT_SELECTED".to_string(),
            timestamp: chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string(),
            app: app.info.clone(),
            window: WindowInfo { id: window_id },
            selected_text: output_text,
            length: output_char_length,
            truncated,
        };

        if self.demo {
            let stdout = std::io::stdout();
            let mut handle = stdout.lock();
            let _ = writeln!(handle, "{}{}{}", BLUE, event.selected_text, RESET);
            let _ = handle.flush();
        } else if let Ok(json) = serde_json::to_string(&event) {
            let stdout = std::io::stdout();
            let mut handle = stdout.lock();
            let _ = writeln!(handle, "{}", json);
            let _ = handle.flush();
        }

        if let Ok(mut last) = self.last_emitted_text.lock() {
            *last = Some(text);
        }
    }
}

fn get_frontmost_app() -> Option<(String, String, i32)> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let bundle_id = app.bundleIdentifier()?.to_string();
    let name = app
        .localizedName()
        .map(|n| n.to_string())
        .unwrap_or_else(|| bundle_id.clone());
    let pid = app.processIdentifier();
    Some((name, bundle_id, pid))
}

fn write_stdout_event(event: &str, data: serde_json::Value) {
    let mut obj = serde_json::Map::new();
    obj.insert("event".to_string(), serde_json::Value::String(event.to_string()));
    obj.insert(
        "timestamp".to_string(),
        serde_json::Value::String(
            chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string(),
        ),
    );
    // Merge in additional data fields
    if let serde_json::Value::Object(map) = data {
        for (k, v) in map {
            obj.insert(k, v);
        }
    }
    if let Ok(json) = serde_json::to_string(&serde_json::Value::Object(obj)) {
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{}", json);
        let _ = handle.flush();
    }
}

fn spawn_stdin_reader(port: u16, auth_token: String, should_exit: Arc<AtomicBool>, last_selected_text: Arc<Mutex<Option<String>>>, demo: bool) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let reader = stdin.lock();
        let url = format!(
            "http://127.0.0.1:{}/proxy-api/v0/co_scientist/llm_inference",
            port
        );
        let auth_header = format!("Bearer {}", auth_token);
        let agent = ureq::Agent::new_with_defaults();

        for line in reader.lines() {
            if should_exit.load(Ordering::Relaxed) {
                break;
            }
            let line = match line {
                Ok(l) => l,
                Err(_) => break, // stdin closed
            };
            if line.is_empty() {
                continue;
            }

            // Build prompt with selected text context if available
            let selected_text = last_selected_text
                .lock()
                .ok()
                .and_then(|guard| guard.clone());

            let content = if let Some(ref sel) = selected_text {
                format!("<selected_text>{}</selected_text>\n{}", sel, line)
            } else {
                line.clone()
            };

            if demo {
                let stdout = std::io::stdout();
                let mut handle = stdout.lock();
                let _ = writeln!(handle, "{}Loading...{}", GREEN, RESET);
                let _ = handle.flush();
            } else {
                write_stdout_event("LLM_LOADING", serde_json::json!({
                    "prompt": line,
                    "selectedText": selected_text
                }));
            }

            let body = serde_json::json!({
                "messages": [{"role": "user", "content": content}]
            });

            let result: Result<ureq::Body, ureq::Error> = agent
                .post(&url)
                .header("Authorization", &auth_header)
                .header("Content-Type", "application/json")
                .send_json(&body)
                .map(|resp| resp.into_body());

            match result {
                Ok(mut body) => match body.read_to_string() {
                    Ok(response_body) => {
                        if demo {
                            // Extract response_text from the JSON response
                            let text = serde_json::from_str::<serde_json::Value>(&response_body)
                                .ok()
                                .and_then(|v| v.get("response_text").and_then(|t| t.as_str()).map(String::from))
                                .unwrap_or(response_body);
                            let stdout = std::io::stdout();
                            let mut handle = stdout.lock();
                            let _ = writeln!(handle, "{}{}{}", BOLD, text, RESET);
                            let _ = handle.flush();
                        } else {
                            write_stdout_event("LLM_RESPONSE", serde_json::json!({
                                "body": serde_json::from_str::<serde_json::Value>(&response_body)
                                    .unwrap_or(serde_json::Value::String(response_body))
                            }));
                        }
                    }
                    Err(e) => {
                        if demo {
                            let stdout = std::io::stdout();
                            let mut handle = stdout.lock();
                            let _ = writeln!(handle, "{}Error: {}{}", RED, e, RESET);
                            let _ = handle.flush();
                        } else {
                            write_stdout_event("LLM_ERROR", serde_json::json!({
                                "error": format!("Error reading response body: {}", e)
                            }));
                        }
                    }
                },
                Err(e) => {
                    if demo {
                        let stdout = std::io::stdout();
                        let mut handle = stdout.lock();
                        let _ = writeln!(handle, "{}Error: {}{}", RED, e, RESET);
                        let _ = handle.flush();
                    } else {
                        write_stdout_event("LLM_ERROR", serde_json::json!({
                            "error": format!("LLM inference request failed: {}", e)
                        }));
                    }
                }
            }
        }
    });
}

fn main() {
    let args = Args::parse();

    // Signal handling
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

    eprintln!("Selection Monitor started");
    eprintln!("Press Ctrl+C to stop");
    eprintln!("---");

    // Initialize NSApplication (required for NSWorkspace notifications)
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let _ = NSApplication::sharedApplication(mtm);
    }

    let last_selected_text: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let monitor = Arc::new(Mutex::new(SelectionMonitor::new(Arc::clone(&last_selected_text), args.demo)));

    // Seed with current frontmost app
    if let Some((name, bundle_id, pid)) = get_frontmost_app() {
        if let Ok(mut m) = monitor.lock() {
            m.set_focused_app(name, bundle_id, pid);
        }
    }

    // Register workspace notifications for app switching
    let monitor_for_ws = Arc::clone(&monitor);
    let ws_callback = Arc::new(Mutex::new(
        move |notif: WorkspaceNotification| match notif.event {
            WorkspaceEvent::AppActivated => {
                let name = notif.app_name.unwrap_or_default();
                let bundle_id = notif.bundle_id.unwrap_or_default();
                if let Ok(mut m) = monitor_for_ws.lock() {
                    m.set_focused_app(name, bundle_id, notif.pid);
                    // Poll immediately on app switch
                    m.poll();
                }
            }
            _ => {}
        },
    ));

    let _ws_tokens: WorkspaceObserverTokens =
        workspace::register_workspace_notifications(ws_callback);

    // Spawn stdin reader thread for LLM inference requests
    if let Some(token) = args.auth_token {
        spawn_stdin_reader(args.port, token, Arc::clone(&should_exit), Arc::clone(&last_selected_text), args.demo);
    }

    // Main loop
    let mut last_poll = Instant::now();

    while !should_exit.load(Ordering::Relaxed) {
        // Drive CFRunLoop (handles NSWorkspace notifications)
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                RUNLOOP_TIMEOUT_SECS,
                1,
            );
        }

        // Poll every 200ms
        if last_poll.elapsed().as_millis() >= POLL_INTERVAL_MS {
            if let Ok(mut m) = monitor.lock() {
                m.poll();
            }
            last_poll = Instant::now();
        }
    }

    eprintln!("Selection Monitor stopped.");
}
