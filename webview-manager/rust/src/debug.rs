use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};

static LOG_FILE: OnceLock<Option<Mutex<File>>> = OnceLock::new();

/// Read `WEBVIEW_MANAGER_DEBUG_LOG` env var and open the file in append mode.
/// Call once at startup; if the var is unset, logging is a no-op.
pub fn init() {
    LOG_FILE.get_or_init(|| {
        std::env::var("WEBVIEW_MANAGER_DEBUG_LOG")
            .ok()
            .and_then(|path| {
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .ok()
                    .map(Mutex::new)
            })
    });
}

/// Write a timestamped line to the debug log (if enabled). Safe to call from
/// anywhere including `define_class!` methods.
pub fn log(msg: &str) {
    if let Some(Some(mtx)) = LOG_FILE.get() {
        if let Ok(mut f) = mtx.lock() {
            let ts = chrono::Utc::now().format("%H:%M:%S%.3f");
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
}

#[macro_export]
macro_rules! debug_log {
    ($($arg:tt)*) => {
        $crate::debug::log(&format!($($arg)*))
    };
}
pub use debug_log;
