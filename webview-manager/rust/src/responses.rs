use chrono::Utc;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Response {
    pub status: &'static str,
    pub command: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub timestamp: String,
}

impl Response {
    pub fn ok(command: &'static str, id: &str) -> Self {
        Self {
            status: "OK",
            command,
            id: id.to_string(),
            error: None,
            timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }

    pub fn error(command: &'static str, id: &str, error: impl Into<String>) -> Self {
        Self {
            status: "ERROR",
            command,
            id: id.to_string(),
            error: Some(error.into()),
            timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }

    pub fn emit(&self) {
        if let Ok(json) = serde_json::to_string(self) {
            println!("{}", json);
        }
    }
}
