use crate::event_types::EventType;
use serde::Serialize;
use std::io::Write;

/// Bounds of a window.
#[derive(Debug, Clone, Serialize)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// App info included in every event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoOutput {
    pub name: String,
    pub identifier: String,
    pub identifier_type: String,
    pub pid: i32,
}

/// Window info included in window-level events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfoOutput {
    pub id: String,
    pub title: Option<String>,
    pub bounds: Option<WindowBounds>,
    pub document_path: Option<String>,
}

/// App-level event (no window key).
#[derive(Debug, Clone, Serialize)]
pub struct AppEventOutput {
    pub event: EventType,
    pub timestamp: String,
    pub platform: String,
    pub app: AppInfoOutput,
}

/// Window-level event (includes window key).
#[derive(Debug, Clone, Serialize)]
pub struct WindowEventOutput {
    pub event: EventType,
    pub timestamp: String,
    pub platform: String,
    pub app: AppInfoOutput,
    pub window: WindowInfoOutput,
}

/// Generate an ISO 8601 timestamp with millisecond precision in UTC.
pub fn now_timestamp() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Emit an app-level event to stdout.
pub fn emit_app_event(event_type: EventType, app: &AppInfoOutput) {
    let event = AppEventOutput {
        event: event_type,
        timestamp: now_timestamp(),
        platform: "macos".to_string(),
        app: app.clone(),
    };
    if let Ok(json) = serde_json::to_string(&event) {
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{}", json);
        let _ = handle.flush();
    }
}

/// Emit a window-level event to stdout.
pub fn emit_window_event(event_type: EventType, app: &AppInfoOutput, window: WindowInfoOutput) {
    let event = WindowEventOutput {
        event: event_type,
        timestamp: now_timestamp(),
        platform: "macos".to_string(),
        app: app.clone(),
        window,
    };
    if let Ok(json) = serde_json::to_string(&event) {
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{}", json);
        let _ = handle.flush();
    }
}
