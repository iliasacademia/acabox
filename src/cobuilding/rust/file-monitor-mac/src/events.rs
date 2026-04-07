use serde::Serialize;
use std::io::Write;

#[derive(Debug, Clone, Copy, Serialize)]
pub enum EventType {
    #[serde(rename = "APP_FOCUSED")]
    AppFocused,
    #[serde(rename = "APP_UNFOCUSED")]
    AppUnfocused,
    #[serde(rename = "WINDOW_FOCUSED")]
    WindowFocused,
    #[serde(rename = "FILE_MONITOR_POLL")]
    FileMonitorPoll,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMonitorEvent {
    pub event: EventType,
    pub timestamp: String,
    pub platform: &'static str,
    pub app: AppInfo,
    pub window: WindowInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub bundle_id: String,
    pub pid: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: Option<u32>,
    pub title: Option<String>,
    pub document_url: Option<String>,
}

pub fn emit_event(event: &FileMonitorEvent) {
    if let Ok(json) = serde_json::to_string(event) {
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{}", json);
        let _ = handle.flush();
    }
}

pub fn now_timestamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}
