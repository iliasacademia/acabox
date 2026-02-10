use crate::accessibility::{self, SafeAXUIElement};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

const MAX_SELECTION_BYTES: usize = 5 * 1024 * 1024; // 5 MB safety cap

/// Represents a change in text selection.
pub enum TextSelectionChange {
    /// Text was selected — written to file.
    Selected { file_path: String, length: usize },
    /// Selection was cleared (was selected, now empty).
    Cleared,
}

/// Tracks text selection state and detects changes.
/// Writes selected text to a temp file instead of returning it inline.
pub struct TextSelectionTracker {
    last_selected_text: Option<String>,
    temp_dir: PathBuf,
}

impl TextSelectionTracker {
    pub fn new(temp_dir: PathBuf) -> Self {
        Self {
            last_selected_text: None,
            temp_dir,
        }
    }

    /// Poll for text selection changes on the given app element.
    /// Returns `Some(change)` if the selection has changed since the last poll.
    pub fn poll(
        &mut self,
        app_element: &SafeAXUIElement,
        focused_window_id: u32,
    ) -> Option<TextSelectionChange> {
        let focused = accessibility::get_focused_ui_element(app_element)?;
        let current_text = accessibility::get_selected_text(&focused);

        // Normalize: treat empty string the same as None
        let current_text = current_text.filter(|s| !s.is_empty());

        if current_text == self.last_selected_text {
            return None;
        }

        let change = match &current_text {
            Some(text) => {
                if text.len() > MAX_SELECTION_BYTES {
                    // Truncate at a char boundary
                    let mut end = MAX_SELECTION_BYTES;
                    while end > 0 && !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    let truncated_text = &text[..end];
                    let length = truncated_text.len();
                    let file_path = self.file_path_for_window(focused_window_id);
                    if atomic_write(&file_path, truncated_text).is_err() {
                        eprintln!(
                            "Failed to write selection text to {}",
                            file_path.display()
                        );
                        return None;
                    }
                    TextSelectionChange::Selected {
                        file_path: file_path.to_string_lossy().to_string(),
                        length,
                    }
                } else {
                    let length = text.len();
                    let file_path = self.file_path_for_window(focused_window_id);
                    if atomic_write(&file_path, text).is_err() {
                        eprintln!(
                            "Failed to write selection text to {}",
                            file_path.display()
                        );
                        return None;
                    }
                    TextSelectionChange::Selected {
                        file_path: file_path.to_string_lossy().to_string(),
                        length,
                    }
                }
            }
            None => {
                // Only emit Cleared if there was a previous selection
                if self.last_selected_text.is_some() {
                    TextSelectionChange::Cleared
                } else {
                    self.last_selected_text = None;
                    return None;
                }
            }
        };

        self.last_selected_text = current_text;
        Some(change)
    }

    /// Reset tracked state (e.g. when app detaches).
    pub fn reset(&mut self) {
        self.last_selected_text = None;
    }

    /// Delete all selection text temp files.
    pub fn cleanup_all(&self) {
        if let Ok(entries) = fs::read_dir(&self.temp_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("window-monitor-sel-") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    fn file_path_for_window(&self, window_id: u32) -> PathBuf {
        self.temp_dir
            .join(format!("window-monitor-sel-{}.txt", window_id))
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
