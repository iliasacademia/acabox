use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct WebviewFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct WebviewEntryState {
    pub url: String,
    pub visible: bool,
    pub frame: WebviewFrame,
}

pub type DesiredState = HashMap<String, WebviewEntryState>;
