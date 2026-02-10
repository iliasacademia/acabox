use crate::accessibility::{self, SafeAXUIElement};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024; // 5 MB safety cap

/// Result of a document text change detection.
pub struct DocumentTextChange {
    pub file_path: String,
    pub character_count: i64,
    pub byte_size: usize,
}

/// Tracks document text content and detects changes via character count polling + debounce.
pub struct DocumentTextTracker {
    last_char_count: Option<i64>,
    last_window_id: u32,
    dirty_since: Option<Instant>,
    debounce_duration: Duration,
    temp_dir: PathBuf,
}

impl DocumentTextTracker {
    pub fn new(temp_dir: PathBuf) -> Self {
        Self {
            last_char_count: None,
            last_window_id: 0,
            dirty_since: None,
            debounce_duration: Duration::from_secs(2),
            temp_dir,
        }
    }

    /// Poll for document text changes. Checks character count (cheap) and debounces
    /// before reading full text.
    pub fn poll(
        &mut self,
        app_element: &SafeAXUIElement,
        focused_window_id: u32,
    ) -> Option<DocumentTextChange> {
        if focused_window_id == 0 {
            return None;
        }

        // If the focused window changed, reset debounce state
        // (the on_window_focused handler does the immediate read)
        if focused_window_id != self.last_window_id {
            self.dirty_since = None;
            self.last_char_count = None;
            self.last_window_id = focused_window_id;
            return None;
        }

        let text_area = self.find_text_area(app_element, focused_window_id)?;
        let char_count = accessibility::get_character_count(&text_area)?;

        if char_count == 0 {
            return None;
        }

        match self.last_char_count {
            Some(last) if last == char_count => {
                // Character count unchanged — check if we have a pending debounce
                if let Some(since) = self.dirty_since {
                    if since.elapsed() >= self.debounce_duration {
                        self.dirty_since = None;
                        return self.read_and_write(&text_area, focused_window_id, char_count);
                    }
                }
                None
            }
            Some(_) => {
                // Character count changed — start or reset debounce timer
                self.last_char_count = Some(char_count);
                self.dirty_since = Some(Instant::now());
                None
            }
            None => {
                // First poll after focus — don't emit here, on_window_focused handles it
                self.last_char_count = Some(char_count);
                None
            }
        }
    }

    /// Called when a window gains focus. Does an immediate read (no debounce).
    pub fn on_window_focused(
        &mut self,
        app_element: &SafeAXUIElement,
        window_id: u32,
    ) -> Option<DocumentTextChange> {
        self.last_window_id = window_id;
        self.dirty_since = None;

        let text_area = self.find_text_area(app_element, window_id)?;
        let char_count = accessibility::get_character_count(&text_area)?;

        if char_count == 0 {
            self.last_char_count = Some(0);
            return None;
        }

        self.last_char_count = Some(char_count);
        self.read_and_write(&text_area, window_id, char_count)
    }

    /// Reset tracked state (e.g. when app detaches).
    pub fn reset(&mut self) {
        self.last_char_count = None;
        self.last_window_id = 0;
        self.dirty_since = None;
    }

    /// Delete all document text temp files.
    pub fn cleanup_all(&self) {
        if let Ok(entries) = fs::read_dir(&self.temp_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("window-monitor-doc-") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    fn find_text_area(
        &self,
        app_element: &SafeAXUIElement,
        window_id: u32,
    ) -> Option<SafeAXUIElement> {
        let ax_window = accessibility::find_ax_window_by_id(app_element, window_id)?;
        accessibility::find_text_area_in_subtree(&ax_window, 10)
    }

    fn read_and_write(
        &self,
        text_area: &SafeAXUIElement,
        window_id: u32,
        char_count: i64,
    ) -> Option<DocumentTextChange> {
        let text = accessibility::get_text_value(text_area)?;

        if text.len() > MAX_TEXT_BYTES {
            eprintln!(
                "Document text exceeds {} MB, skipping write",
                MAX_TEXT_BYTES / 1024 / 1024
            );
            return None;
        }

        let byte_size = text.len();
        let file_path = self.file_path_for_window(window_id);
        if atomic_write(&file_path, &text).is_err() {
            eprintln!("Failed to write document text to {}", file_path.display());
            return None;
        }

        Some(DocumentTextChange {
            file_path: file_path.to_string_lossy().to_string(),
            character_count: char_count,
            byte_size,
        })
    }

    fn file_path_for_window(&self, window_id: u32) -> PathBuf {
        self.temp_dir
            .join(format!("window-monitor-doc-{}.txt", window_id))
    }
}

/// Write content to a file atomically (write to .tmp, then rename).
fn atomic_write(path: &PathBuf, content: &str) -> std::io::Result<()> {
    let tmp_path = PathBuf::from(format!("{}.tmp", path.display()));
    let mut file = fs::File::create(&tmp_path)?;
    file.write_all(content.as_bytes())?;
    file.flush()?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}
