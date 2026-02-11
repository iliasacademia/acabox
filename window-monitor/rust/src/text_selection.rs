use crate::accessibility::{self, SafeAXUIElement};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

const MAX_SELECTION_BYTES: usize = 5 * 1024 * 1024; // 5 MB safety cap
const BOUNDS_TOLERANCE: f64 = 2.0;

/// Represents a change in text selection.
pub enum TextSelectionChange {
    /// Text was selected — written to file.
    Selected {
        file_path: String,
        length: usize,
        bounds: Option<(f64, f64, f64, f64)>,
    },
    /// Selection was cleared (was selected, now empty).
    Cleared,
    /// Selection bounds changed on screen (text unchanged, e.g. scroll/zoom).
    /// Raw signal — debounce happens in window_monitor.
    BoundsChanged,
}

/// Action returned by debounce state machine methods.
pub enum SelectionBoundsAction {
    None,
    EmitRepositioning,
    EmitRepositioned,
}

/// Tracks text selection state and detects changes.
/// Writes selected text to a temp file instead of returning it inline.
pub struct TextSelectionTracker {
    last_selected_text: Option<String>,
    last_bounds: Option<(f64, f64, f64, f64)>,
    temp_dir: PathBuf,
    // Debounce state for selection bounds movement
    bounds_reposition_active: bool,
    bounds_last_change: Option<Instant>,
}

impl TextSelectionTracker {
    pub fn new(temp_dir: PathBuf) -> Self {
        Self {
            last_selected_text: None,
            last_bounds: None,
            temp_dir,
            bounds_reposition_active: false,
            bounds_last_change: None,
        }
    }

    /// Poll for text selection changes on the given app element.
    /// Returns `Some(change)` if the selection or its bounds have changed since the last poll.
    pub fn poll(
        &mut self,
        app_element: &SafeAXUIElement,
        focused_window_id: u32,
    ) -> Option<TextSelectionChange> {
        let focused = accessibility::get_focused_ui_element(app_element)?;
        let current_text = accessibility::get_selected_text(&focused);

        // Normalize: treat empty string the same as None
        let current_text = current_text.filter(|s| !s.is_empty());

        let text_changed = current_text != self.last_selected_text;

        if text_changed {
            let change = match &current_text {
                Some(text) => {
                    let write_text = if text.len() > MAX_SELECTION_BYTES {
                        let mut end = MAX_SELECTION_BYTES;
                        while end > 0 && !text.is_char_boundary(end) {
                            end -= 1;
                        }
                        &text[..end]
                    } else {
                        text.as_str()
                    };
                    let length = write_text.len();
                    let file_path = self.file_path_for_window(focused_window_id);
                    if atomic_write(&file_path, write_text).is_err() {
                        eprintln!(
                            "Failed to write selection text to {}",
                            file_path.display()
                        );
                        return None;
                    }
                    // Query bounds for the new selection
                    let bounds = Self::query_bounds(&focused);
                    self.last_bounds = bounds;
                    TextSelectionChange::Selected {
                        file_path: file_path.to_string_lossy().to_string(),
                        length,
                        bounds,
                    }
                }
                None => {
                    if self.last_selected_text.is_some() {
                        self.last_bounds = None;
                        TextSelectionChange::Cleared
                    } else {
                        self.last_selected_text = None;
                        self.last_bounds = None;
                        return None;
                    }
                }
            };

            self.last_selected_text = current_text;
            return Some(change);
        }

        // Text unchanged — check if bounds moved (only when there's an active selection)
        if self.last_selected_text.is_some() {
            let current_bounds = Self::query_bounds(&focused);
            if let (Some(last), Some(current)) = (self.last_bounds, current_bounds) {
                let moved = (current.0 - last.0).abs() > BOUNDS_TOLERANCE
                    || (current.1 - last.1).abs() > BOUNDS_TOLERANCE
                    || (current.2 - last.2).abs() > BOUNDS_TOLERANCE
                    || (current.3 - last.3).abs() > BOUNDS_TOLERANCE;
                if moved {
                    self.last_bounds = Some(current);
                    return Some(TextSelectionChange::BoundsChanged);
                }
            } else if self.last_bounds.is_none() && current_bounds.is_some() {
                // Bounds became available (e.g. app finished rendering)
                self.last_bounds = current_bounds;
                return Some(TextSelectionChange::BoundsChanged);
            }
        }

        None
    }

    /// Cheap bounds-only poll: skips text content, only checks if selection bounds moved.
    /// Returns `BoundsChanged` when bounds have moved, `None` otherwise.
    /// Call this every main loop iteration for low-latency scroll tracking.
    pub fn poll_bounds_only(
        &mut self,
        app_element: &SafeAXUIElement,
    ) -> Option<TextSelectionChange> {
        // No active selection — nothing to track
        if self.last_selected_text.is_none() {
            return None;
        }

        let focused = accessibility::get_focused_ui_element(app_element)?;
        let current_bounds = Self::query_bounds(&focused);

        if let (Some(last), Some(current)) = (self.last_bounds, current_bounds) {
            let moved = (current.0 - last.0).abs() > BOUNDS_TOLERANCE
                || (current.1 - last.1).abs() > BOUNDS_TOLERANCE
                || (current.2 - last.2).abs() > BOUNDS_TOLERANCE
                || (current.3 - last.3).abs() > BOUNDS_TOLERANCE;
            if moved {
                self.last_bounds = Some(current);
                return Some(TextSelectionChange::BoundsChanged);
            }
        } else if self.last_bounds.is_none() && current_bounds.is_some() {
            self.last_bounds = current_bounds;
            return Some(TextSelectionChange::BoundsChanged);
        }

        None
    }

    /// Query the screen bounds of the current selection as a tuple.
    fn query_bounds(focused: &SafeAXUIElement) -> Option<(f64, f64, f64, f64)> {
        let rect = accessibility::get_selection_bounds(focused)?;
        Some((
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        ))
    }

    /// Called when a scroll event is detected (via NSEvent global monitor).
    /// Like `on_bounds_changed()` but guards on active selection first.
    pub fn on_scroll_detected(&mut self) -> SelectionBoundsAction {
        if self.last_selected_text.is_none() {
            return SelectionBoundsAction::None;
        }
        self.bounds_last_change = Some(Instant::now());
        if !self.bounds_reposition_active {
            self.bounds_reposition_active = true;
            SelectionBoundsAction::EmitRepositioning
        } else {
            SelectionBoundsAction::None
        }
    }

    /// Called when `poll()` returns `BoundsChanged`.
    /// Returns `EmitRepositioning` on the first change, `None` on subsequent.
    pub fn on_bounds_changed(&mut self) -> SelectionBoundsAction {
        self.bounds_last_change = Some(Instant::now());
        if !self.bounds_reposition_active {
            self.bounds_reposition_active = true;
            SelectionBoundsAction::EmitRepositioning
        } else {
            SelectionBoundsAction::None
        }
    }

    /// Check if selection bounds debounce has elapsed (called from main loop).
    /// Returns `EmitRepositioned` when movement has stabilized.
    pub fn check_bounds_end(&mut self, debounce_ms: u128) -> SelectionBoundsAction {
        if !self.bounds_reposition_active {
            return SelectionBoundsAction::None;
        }
        if let Some(last) = self.bounds_last_change {
            if last.elapsed().as_millis() >= debounce_ms {
                self.bounds_reposition_active = false;
                self.bounds_last_change = None;
                return SelectionBoundsAction::EmitRepositioned;
            }
        }
        SelectionBoundsAction::None
    }

    /// Reset the debounce timer if a reposition is active.
    /// Used by scroll detection to keep the timer alive between discrete scroll events.
    pub fn extend_bounds_debounce(&mut self) {
        if self.bounds_reposition_active {
            self.bounds_last_change = Some(Instant::now());
        }
    }

    /// Force-finish any active bounds reposition (e.g. on selection clear/change).
    pub fn force_finish_bounds(&mut self) -> SelectionBoundsAction {
        if self.bounds_reposition_active {
            self.bounds_reposition_active = false;
            self.bounds_last_change = None;
            SelectionBoundsAction::EmitRepositioned
        } else {
            SelectionBoundsAction::None
        }
    }

    /// Get the latest known selection bounds.
    pub fn latest_bounds(&self) -> Option<(f64, f64, f64, f64)> {
        self.last_bounds
    }

    /// Reset tracked state (e.g. when app detaches).
    pub fn reset(&mut self) {
        self.last_selected_text = None;
        self.last_bounds = None;
        self.bounds_reposition_active = false;
        self.bounds_last_change = None;
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
