use serde::Serialize;

/// All 11 event types emitted by the window monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum EventType {
    #[serde(rename = "WINDOW_CREATED")]
    WindowCreated,
    #[serde(rename = "WINDOW_DESTROYED")]
    WindowDestroyed,
    #[serde(rename = "WINDOW_EXISTING")]
    WindowExisting,
    #[serde(rename = "WINDOW_FOCUSED")]
    WindowFocused,
    #[serde(rename = "WINDOW_REPOSITIONING")]
    WindowRepositioning,
    #[serde(rename = "WINDOW_REPOSITIONED")]
    WindowRepositioned,
    #[serde(rename = "APP_FOCUSED")]
    AppFocused,
    #[serde(rename = "APP_UNFOCUSED")]
    AppUnfocused,
    #[serde(rename = "APP_LAUNCHED")]
    AppLaunched,
    #[serde(rename = "APP_TERMINATED")]
    AppTerminated,
    #[serde(rename = "APP_EXISTING")]
    AppExisting,
}

impl EventType {
    #[allow(dead_code)]
    pub fn is_app_event(self) -> bool {
        matches!(
            self,
            EventType::AppFocused
                | EventType::AppUnfocused
                | EventType::AppLaunched
                | EventType::AppTerminated
                | EventType::AppExisting
        )
    }
}
