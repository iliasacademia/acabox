use crate::accessibility::{self, SafeAXUIElement};
use crate::applescript;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
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
    last_content_hash: Option<u64>,
    last_window_id: u32,
    dirty_since: Option<Instant>,
    debounce_duration: Duration,
    temp_dir: PathBuf,
    bundle_id: String,
}

impl DocumentTextTracker {
    pub fn new(temp_dir: PathBuf, bundle_id: String) -> Self {
        Self {
            last_char_count: None,
            last_content_hash: None,
            last_window_id: 0,
            dirty_since: None,
            debounce_duration: Duration::from_secs(2),
            temp_dir,
            bundle_id,
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
            self.last_content_hash = None;
            self.last_window_id = focused_window_id;
            return None;
        }

        let text_areas = self.find_text_areas(app_element, focused_window_id);
        if text_areas.is_empty() {
            return None;
        }
        let char_count: i64 = text_areas
            .iter()
            .filter_map(|ta| accessibility::get_character_count(ta))
            .sum();

        if char_count == 0 {
            return None;
        }

        match self.last_char_count {
            Some(last) if last == char_count => {
                // Character count unchanged — check if we have a pending debounce
                if let Some(since) = self.dirty_since {
                    if since.elapsed() >= self.debounce_duration {
                        self.dirty_since = None;
                        return self.read_and_write(app_element, &text_areas, focused_window_id, char_count);
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
                // First poll detecting text — start debounce so we read after stabilization.
                // on_window_focused may have missed the initial read if accessibility wasn't ready.
                self.last_char_count = Some(char_count);
                self.dirty_since = Some(Instant::now());
                None
            }
        }
    }

    /// Called when a window gains focus. Does an immediate read (no debounce).
    /// Skips re-read if the same window regains focus (e.g., after overlay click
    /// causes deactivation/reactivation), since the temp file already has valid
    /// content and the accessibility API may return incomplete data during rapid
    /// focus transitions.
    pub fn on_window_focused(
        &mut self,
        app_element: &SafeAXUIElement,
        window_id: u32,
    ) -> Option<DocumentTextChange> {
        let is_same_window = window_id == self.last_window_id;
        self.last_window_id = window_id;
        self.dirty_since = None;

        if is_same_window {
            return None;
        }

        self.last_content_hash = None;
        self.last_char_count = None;

        let text_areas = self.find_text_areas(app_element, window_id);
        if text_areas.is_empty() {
            return None;
        }
        let char_count: i64 = text_areas
            .iter()
            .filter_map(|ta| accessibility::get_character_count(ta))
            .sum();

        if char_count == 0 {
            self.last_char_count = Some(0);
            return None;
        }

        self.last_char_count = Some(char_count);
        self.read_and_write(app_element, &text_areas, window_id, char_count)
    }

    /// Reset tracked state (e.g. when app detaches).
    pub fn reset(&mut self) {
        self.last_char_count = None;
        self.last_content_hash = None;
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

    fn find_text_areas(
        &self,
        app_element: &SafeAXUIElement,
        window_id: u32,
    ) -> Vec<SafeAXUIElement> {
        let Some(ax_window) = accessibility::find_ax_window_by_id(app_element, window_id) else {
            return Vec::new();
        };
        accessibility::find_all_text_areas_in_subtree(&ax_window, 10)
    }

    fn read_and_write(
        &mut self,
        app_element: &SafeAXUIElement,
        text_areas: &[SafeAXUIElement],
        window_id: u32,
        char_count: i64,
    ) -> Option<DocumentTextChange> {
        // For Microsoft Word, use AppleScript to get full document text
        // (the AX API truncates at ~47KB for large documents).
        let text = if self.bundle_id == "com.microsoft.Word" {
            match applescript::get_word_document_text(app_element, window_id) {
                Ok(t) if !t.is_empty() => t,
                _ => {
                    // Fall back to AX API if AppleScript fails
                    let texts: Vec<String> = text_areas
                        .iter()
                        .filter_map(|ta| accessibility::get_text_value(ta))
                        .collect();
                    if texts.is_empty() {
                        return None;
                    }
                    texts.join("\n")
                }
            }
        } else {
            let texts: Vec<String> = text_areas
                .iter()
                .filter_map(|ta| accessibility::get_text_value(ta))
                .collect();
            if texts.is_empty() {
                return None;
            }
            texts.join("\n")
        };

        if text.len() > MAX_TEXT_BYTES {
            eprintln!(
                "Document text exceeds {} MB, skipping write",
                MAX_TEXT_BYTES / 1024 / 1024
            );
            return None;
        }

        // Skip emission if content hasn't actually changed
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        let content_hash = hasher.finish();

        if self.last_content_hash == Some(content_hash) {
            return None;
        }
        self.last_content_hash = Some(content_hash);

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
