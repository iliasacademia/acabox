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

/// Internal enum to track where bounds should be queried from.
enum BoundsSource {
    /// Multiple text areas found (multi-page Word document).
    AllPages(Vec<SafeAXUIElement>),
    /// Single focused element (fallback).
    Focused(Option<SafeAXUIElement>),
}

/// Tracks text selection state and detects changes.
/// Writes selected text to a temp file instead of returning it inline.
pub struct TextSelectionTracker {
    last_selected_text: Option<String>,
    last_bounds: Option<(f64, f64, f64, f64)>,
    temp_dir: PathBuf,
    bundle_id: String,
    // Debounce state for selection bounds movement
    bounds_reposition_active: bool,
    bounds_last_change: Option<Instant>,
}

impl TextSelectionTracker {
    pub fn new(temp_dir: PathBuf, bundle_id: String) -> Self {
        Self {
            last_selected_text: None,
            last_bounds: None,
            temp_dir,
            bundle_id,
            bounds_reposition_active: false,
            bounds_last_change: None,
        }
    }

    pub fn set_bundle_id(&mut self, bundle_id: String) {
        self.bundle_id = bundle_id;
    }

    fn is_word(&self) -> bool {
        self.bundle_id == "com.microsoft.Word"
    }

    /// Poll for text selection changes on the given app element.
    /// Returns `Some(change)` if the selection or its bounds have changed since the last poll.
    pub fn poll(
        &mut self,
        app_element: &SafeAXUIElement,
        focused_window_id: u32,
    ) -> Option<TextSelectionChange> {
        let (current_text, bounds_source) = if self.is_word() {
            // Word: multi-page approach (each page is a separate AXTextArea)
            let (text, text_areas) =
                self.collect_selected_text_from_all_pages(app_element, focused_window_id);
            if text.is_some() {
                (text, BoundsSource::AllPages(text_areas))
            } else {
                // Fallback to focused element with AXTextArea role check
                let focused = accessibility::get_focused_ui_element(app_element);
                let text = focused
                    .as_ref()
                    .filter(|f| accessibility::get_role(f).as_deref() == Some("AXTextArea"))
                    .and_then(|f| accessibility::get_selected_text(f));
                let text = text.filter(|s| !s.is_empty());
                (text, BoundsSource::Focused(focused))
            }
        } else {
            // Non-Word apps: query focused element directly (no role filter)
            let focused = accessibility::get_focused_ui_element(app_element);
            let text = focused
                .as_ref()
                .and_then(|f| accessibility::get_selected_text(f));
            let text = text.filter(|s| !s.is_empty());
            (text, BoundsSource::Focused(focused))
        };

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
                    let bounds = Self::query_bounds_for_source(&bounds_source);
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
            let current_bounds = Self::query_bounds_for_source(&bounds_source);
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
        focused_window_id: u32,
    ) -> Option<TextSelectionChange> {
        // No active selection — nothing to track
        if self.last_selected_text.is_none() {
            return None;
        }

        let current_bounds = if self.is_word() {
            // Word: try multi-page bounds first, then fall back to focused element
            self.get_all_page_text_areas(app_element, focused_window_id)
                .and_then(|text_areas| Self::query_bounds_from_text_areas(&text_areas))
                .or_else(|| {
                    accessibility::get_focused_ui_element(app_element)
                        .and_then(|f| Self::query_bounds(&f))
                })
        } else {
            // Non-Word: query focused element directly
            accessibility::get_focused_ui_element(app_element)
                .and_then(|f| Self::query_bounds(&f))
        };

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

    /// Query the screen bounds of the current selection from a single element.
    fn query_bounds(element: &SafeAXUIElement) -> Option<(f64, f64, f64, f64)> {
        let rect = accessibility::get_selection_bounds(element)?;
        Some((
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        ))
    }

    /// Query bounds from the appropriate source (multi-page or single focused element).
    fn query_bounds_for_source(source: &BoundsSource) -> Option<(f64, f64, f64, f64)> {
        match source {
            BoundsSource::AllPages(text_areas) => {
                Self::query_bounds_from_text_areas(text_areas)
            }
            BoundsSource::Focused(focused) => {
                focused.as_ref().and_then(|f| Self::query_bounds(f))
            }
        }
    }

    /// Compute the union bounding box across all text areas that have a selection.
    fn query_bounds_from_text_areas(
        text_areas: &[SafeAXUIElement],
    ) -> Option<(f64, f64, f64, f64)> {
        let mut union_rect: Option<(f64, f64, f64, f64)> = None;
        for ta in text_areas {
            if let Some(rect) = accessibility::get_selection_bounds(ta) {
                if rect.size.width == 0.0 && rect.size.height == 0.0 {
                    continue;
                }
                match union_rect {
                    None => {
                        union_rect = Some((
                            rect.origin.x,
                            rect.origin.y,
                            rect.size.width,
                            rect.size.height,
                        ));
                    }
                    Some((x, y, w, h)) => {
                        let min_x = x.min(rect.origin.x);
                        let min_y = y.min(rect.origin.y);
                        let max_x = (x + w).max(rect.origin.x + rect.size.width);
                        let max_y = (y + h).max(rect.origin.y + rect.size.height);
                        union_rect = Some((min_x, min_y, max_x - min_x, max_y - min_y));
                    }
                }
            }
        }
        union_rect
    }

    /// Collect selected text from all AXTextArea elements in the focused window.
    /// Returns the concatenated selection and the text areas that were found.
    fn collect_selected_text_from_all_pages(
        &self,
        app_element: &SafeAXUIElement,
        window_id: u32,
    ) -> (Option<String>, Vec<SafeAXUIElement>) {
        let text_areas = match self.get_all_page_text_areas(app_element, window_id) {
            Some(areas) => areas,
            None => return (None, Vec::new()),
        };

        let selections: Vec<String> = text_areas
            .iter()
            .filter_map(|ta| accessibility::get_selected_text(ta))
            .filter(|s| !s.is_empty())
            .collect();

        if selections.is_empty() {
            return (None, text_areas);
        }

        (Some(selections.join("\n")), text_areas)
    }

    /// Find all AXTextArea elements in the window matching the given window ID.
    fn get_all_page_text_areas(
        &self,
        app_element: &SafeAXUIElement,
        window_id: u32,
    ) -> Option<Vec<SafeAXUIElement>> {
        let ax_window = accessibility::find_ax_window_by_id(app_element, window_id)?;
        let text_areas = accessibility::find_all_text_areas_in_subtree(&ax_window, 10);
        if text_areas.is_empty() {
            return None;
        }
        Some(text_areas)
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
/// Falls back to direct write if atomic rename fails.
fn atomic_write(path: &PathBuf, content: &str) -> std::io::Result<()> {
    let tmp_path = PathBuf::from(format!("{}.tmp", path.display()));
    let mut file = fs::File::create(&tmp_path)?;
    file.write_all(content.as_bytes())?;
    file.flush()?;
    match fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Rename failed — fall back to direct write
            let _ = fs::remove_file(&tmp_path);
            let mut file = fs::File::create(path)?;
            file.write_all(content.as_bytes())?;
            file.flush()?;
            Ok(())
        }
    }
}
