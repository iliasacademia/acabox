use crate::accessibility::{self, SafeAXObserver, SafeAXUIElement};
use crate::document_text::DocumentTextTracker;
use crate::event_models::{self, AppInfoOutput, DocumentTextInfo, SelectionBounds, TextSelectionInfo, WindowBounds, WindowInfoOutput};
use crate::event_types::EventType;
use crate::text_selection::{SelectionBoundsAction, TextSelectionChange, TextSelectionTracker};
use crate::window_list::{self, WindowListEntry};
use crate::workspace;
use core_foundation::base::TCFType;
use core_foundation::runloop::{CFRunLoop, CFRunLoopSource};
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

const BOUNDS_TOLERANCE: f64 = 2.0;
const RESIZE_DEBOUNCE_MS: u128 = 150;
const SELECTION_BOUNDS_DEBOUNCE_MS: u128 = 150;
const DEFERRED_CHECK_DELAY_MS: u128 = 100;

// --- SendPtr: makes a raw pointer Send+Sync for the workspace callback ---

struct SendPtr(*mut WindowMonitor);
unsafe impl Send for SendPtr {}
unsafe impl Sync for SendPtr {}

impl SendPtr {
    fn get(&self) -> *mut WindowMonitor {
        self.0
    }
}

// --- TrackedWindow: consolidated per-window state ---

struct TrackedWindow {
    /// True if this window passed the AXWindow role filter and emitted CREATED/EXISTING.
    is_emitted: bool,
    /// Cached bounds for change detection (only set for emitted windows).
    bounds: Option<(f64, f64, f64, f64)>,
    /// Cached document path for change detection.
    document_path: Option<String>,
}

// --- RepositionTracker: debounce state machine for resize/move ---

enum RepositionAction {
    None,
    EmitRepositioning,
    EmitRepositioned,
}

struct RepositionTracker {
    is_active: bool,
    last_change: Option<Instant>,
}

impl RepositionTracker {
    fn new() -> Self {
        Self {
            is_active: false,
            last_change: None,
        }
    }

    fn on_bounds_changed(&mut self) -> RepositionAction {
        self.last_change = Some(Instant::now());
        if !self.is_active {
            self.is_active = true;
            RepositionAction::EmitRepositioning
        } else {
            RepositionAction::None
        }
    }

    fn check_end(&mut self, debounce_ms: u128) -> RepositionAction {
        if !self.is_active {
            return RepositionAction::None;
        }
        if let Some(last) = self.last_change {
            if last.elapsed().as_millis() >= debounce_ms {
                self.is_active = false;
                self.last_change = None;
                return RepositionAction::EmitRepositioned;
            }
        }
        RepositionAction::None
    }

    fn force_finish(&mut self) -> RepositionAction {
        if self.is_active {
            self.is_active = false;
            self.last_change = None;
            RepositionAction::EmitRepositioned
        } else {
            RepositionAction::None
        }
    }

    fn reset(&mut self) {
        self.is_active = false;
        self.last_change = None;
    }
}

// --- DeferredCheck: timer state machine for deferred window checks ---

struct DeferredCheck {
    pending: bool,
    scheduled_at: Option<Instant>,
}

impl DeferredCheck {
    fn new() -> Self {
        Self {
            pending: false,
            scheduled_at: None,
        }
    }

    fn schedule(&mut self) {
        self.pending = true;
        self.scheduled_at = Some(Instant::now());
    }

    fn should_execute(&mut self, delay_ms: u128) -> bool {
        if !self.pending {
            return false;
        }
        if self.scheduled_at.is_some_and(|t| t.elapsed().as_millis() >= delay_ms) {
            self.pending = false;
            self.scheduled_at = None;
            true
        } else {
            false
        }
    }

    fn reset(&mut self) {
        self.pending = false;
        self.scheduled_at = None;
    }
}

// --- WindowMonitor ---

pub struct WindowMonitor {
    // App identity
    pub target_bundle_id: String,
    pub app_display_name: Option<String>,
    pub word_pid: i32,

    // Content area detection config
    content_area_role: Option<String>,

    // Window tracking (single consolidated map)
    windows: HashMap<u32, TrackedWindow>,

    // AX observer state
    ax_observer: Option<SafeAXObserver>,
    app_element: Option<SafeAXUIElement>,
    observed_window_element: Option<SafeAXUIElement>,
    runloop_source: Option<CFRunLoopSource>,

    // Focus tracking
    last_focused_window_id: u32,
    last_content_bounds: Option<(f64, f64, f64, f64)>,
    last_scroll_time: Option<Instant>,

    // Debounce state machines
    reposition: RepositionTracker,
    deferred_check: DeferredCheck,

    // Text selection tracking
    text_selection: Option<TextSelectionTracker>,

    // Document text tracking
    document_text: Option<DocumentTextTracker>,

    // Lifecycle
    workspace_tokens: Option<workspace::WorkspaceObserverTokens>,
    is_monitoring: bool,
}

impl WindowMonitor {
    pub fn new(
        bundle_id: &str,
        track_text_selection: bool,
        track_document_text: bool,
        temp_dir: PathBuf,
        content_area_role: Option<String>,
    ) -> Self {
        WindowMonitor {
            target_bundle_id: bundle_id.to_string(),
            app_display_name: None,
            word_pid: 0,
            content_area_role,
            windows: HashMap::new(),
            ax_observer: None,
            app_element: None,
            observed_window_element: None,
            runloop_source: None,
            last_focused_window_id: 0,
            last_content_bounds: None,
            last_scroll_time: None,
            reposition: RepositionTracker::new(),
            deferred_check: DeferredCheck::new(),
            text_selection: if track_text_selection {
                Some(TextSelectionTracker::new(temp_dir.clone()))
            } else {
                None
            },
            document_text: if track_document_text {
                Some(DocumentTextTracker::new(temp_dir))
            } else {
                None
            },
            workspace_tokens: None,
            is_monitoring: false,
        }
    }

    pub fn app_info(&self) -> AppInfoOutput {
        AppInfoOutput {
            name: self
                .app_display_name
                .clone()
                .unwrap_or_else(|| self.target_bundle_id.clone()),
            identifier: self.target_bundle_id.clone(),
            identifier_type: "bundleId".to_string(),
            pid: self.word_pid,
        }
    }

    /// Start monitoring: register workspace notifications, check if app is running.
    pub fn start_monitoring(&mut self, self_ptr: *mut WindowMonitor, should_exit: &Arc<AtomicBool>) {
        if self.is_monitoring {
            return;
        }
        self.is_monitoring = true;
        eprintln!("Starting window monitor for {}...", self.target_bundle_id);

        // Register workspace notifications
        let bundle_id = self.target_bundle_id.clone();
        let should_exit_clone = Arc::clone(should_exit);
        let ptr = SendPtr(self_ptr);

        let callback = Arc::new(std::sync::Mutex::new(
            move |notif: workspace::WorkspaceNotification| {
                if should_exit_clone.load(Ordering::Relaxed) {
                    return;
                }
                // Handle system-wide events (no bundle_id) before app-specific filter
                if let workspace::WorkspaceEvent::SpaceChanged = notif.event {
                    let m = unsafe { &mut *ptr.get() };
                    if m.word_pid != 0 {
                        let windows = window_list::get_windows_for_pid(m.word_pid);
                        m.check_for_window_changes(&windows);
                        m.check_for_focus_change(&windows);
                    }
                    return;
                }

                let Some(ref bid) = notif.bundle_id else {
                    return;
                };
                if bid != &bundle_id {
                    return;
                }
                let m = unsafe { &mut *ptr.get() };
                match notif.event {
                    workspace::WorkspaceEvent::AppLaunched => {
                        if m.app_display_name.is_none() {
                            m.app_display_name = notif.app_name.clone();
                        }
                        m.word_pid = notif.pid;
                        event_models::emit_app_event(EventType::AppLaunched, &m.app_info());
                        m.cleanup_all_temp_files();
                        m.attach_to_app();
                    }
                    workspace::WorkspaceEvent::AppTerminated => {
                        m.emit_destroyed_events_for_all_tracked_windows();
                        event_models::emit_app_event(EventType::AppTerminated, &m.app_info());
                        m.cleanup_all_temp_files();
                        m.detach_from_app();
                    }
                    workspace::WorkspaceEvent::AppActivated => {
                        event_models::emit_app_event(EventType::AppFocused, &m.app_info());
                        let windows = window_list::get_windows_for_pid(m.word_pid);
                        m.check_for_focus_change(&windows);
                    }
                    workspace::WorkspaceEvent::AppDeactivated => {
                        event_models::emit_app_event(EventType::AppUnfocused, &m.app_info());
                        m.last_focused_window_id = 0;
                        m.last_content_bounds = None;
                    }
                    workspace::WorkspaceEvent::SpaceChanged => unreachable!(),
                }
            },
        ));

        let tokens = workspace::register_workspace_notifications(callback);
        self.workspace_tokens = Some(tokens);

        // Check if target app is already running
        if let Some((pid, name)) = workspace::find_running_app(&self.target_bundle_id) {
            self.word_pid = pid;
            if self.app_display_name.is_none() {
                self.app_display_name = Some(name);
            }
            eprintln!(
                "{} is already running (PID: {})",
                self.app_display_name.as_deref().unwrap_or(&self.target_bundle_id),
                pid
            );
            event_models::emit_app_event(EventType::AppExisting, &self.app_info());
            self.attach_to_app();
        }
    }

    /// Stop monitoring: remove all observers and clean up.
    pub fn stop_monitoring(&mut self) {
        if !self.is_monitoring {
            return;
        }
        self.is_monitoring = false;
        eprintln!("Stopping window monitor...");

        self.cleanup_all_temp_files();
        self.workspace_tokens = None;
        self.detach_from_app();
    }

    /// Attach to the target app: create AX observer and enumerate windows.
    fn attach_to_app(&mut self) {
        if self.word_pid == 0 {
            return;
        }

        let app_element = match accessibility::create_app_element(self.word_pid) {
            Some(el) => el,
            None => {
                eprintln!("Failed to create AXUIElement for app");
                return;
            }
        };

        let observer = match accessibility::create_observer(self.word_pid, ax_observer_callback) {
            Some(obs) => obs,
            None => {
                eprintln!("Failed to create AXObserver");
                return;
            }
        };

        let context = self as *mut WindowMonitor as *mut c_void;
        observer.add_notification(
            &app_element,
            accessibility::k_ax_window_created_notification(),
            context,
        );
        observer.add_notification(
            &app_element,
            accessibility::k_ax_ui_element_destroyed_notification(),
            context,
        );
        observer.add_notification(
            &app_element,
            accessibility::k_ax_focused_window_changed_notification(),
            context,
        );

        if let Some(source) = observer.get_runloop_source() {
            let run_loop = CFRunLoop::get_current();
            unsafe {
                core_foundation::runloop::CFRunLoopAddSource(
                    run_loop.as_concrete_TypeRef(),
                    source.as_concrete_TypeRef(),
                    core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                );
            }
            self.runloop_source = Some(source);
        }

        self.app_element = Some(app_element);
        self.ax_observer = Some(observer);

        eprintln!(
            "Attached to {}, observing window events...",
            self.app_display_name.as_deref().unwrap_or(&self.target_bundle_id)
        );

        self.enumerate_existing_windows();
    }

    /// Detach from app: clean up observers and state.
    fn detach_from_app(&mut self) {
        self.unregister_resize_observers();

        if let Some(ref source) = self.runloop_source {
            let run_loop = CFRunLoop::get_current();
            unsafe {
                core_foundation::runloop::CFRunLoopRemoveSource(
                    run_loop.as_concrete_TypeRef(),
                    source.as_concrete_TypeRef(),
                    core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                );
            }
        }
        self.runloop_source = None;

        self.ax_observer = None;
        self.app_element = None;
        self.word_pid = 0;
        self.reposition.reset();
        self.windows.clear();
        self.deferred_check.reset();
        if let Some(ref mut tracker) = self.text_selection {
            tracker.reset();
        }
        if let Some(ref mut tracker) = self.document_text {
            tracker.reset();
        }
    }

    /// Register move/resize observers on a specific window element.
    fn register_resize_observers_for_window(&mut self, window_element: SafeAXUIElement) {
        if self.ax_observer.is_none() {
            return;
        }

        // Unregister from previous window first
        self.unregister_resize_observers();

        let context = self as *mut WindowMonitor as *mut c_void;
        let observer = self.ax_observer.as_ref().unwrap();
        observer.add_notification(
            &window_element,
            accessibility::k_ax_moved_notification(),
            context,
        );
        observer.add_notification(
            &window_element,
            accessibility::k_ax_resized_notification(),
            context,
        );
        observer.add_notification(
            &window_element,
            accessibility::k_ax_title_changed_notification(),
            context,
        );

        self.observed_window_element = Some(window_element);
    }

    /// Unregister move/resize observers from the currently observed window.
    fn unregister_resize_observers(&mut self) {
        if let (Some(ref element), Some(ref observer)) =
            (&self.observed_window_element, &self.ax_observer)
        {
            observer.remove_notification(element, accessibility::k_ax_moved_notification());
            observer.remove_notification(element, accessibility::k_ax_resized_notification());
            observer.remove_notification(element, accessibility::k_ax_title_changed_notification());
        }
        self.observed_window_element = None;

        // If we were repositioning, emit the final event
        if let RepositionAction::EmitRepositioned = self.reposition.force_finish() {
            self.emit_resized_event_for_focused_window();
        }
    }

    /// Enumerate existing windows and emit WINDOW_EXISTING events.
    fn enumerate_existing_windows(&mut self) {
        let windows = window_list::get_windows_for_pid(self.word_pid);
        let mut emitted_count = 0;

        for w in &windows {
            self.windows.entry(w.window_id).or_insert(TrackedWindow {
                is_emitted: false,
                bounds: None,
                document_path: None,
            });

            let role = self.get_role_for_window(w.window_id);
            if role.as_deref() != Some("AXWindow") {
                continue;
            }

            let window_info = self.create_window_info_from_entry(w, false);

            let entry = self.windows.get_mut(&w.window_id).unwrap();
            entry.is_emitted = true;
            entry.bounds = Some((w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height));
            entry.document_path = window_info.document_path.clone();
            emitted_count += 1;

            let app = self.app_info();
            event_models::emit_window_event(EventType::WindowExisting, &app, window_info);
        }

        eprintln!(
            "Found {} windows, emitted {} WINDOW_EXISTING events",
            windows.len(),
            emitted_count
        );
    }

    /// Poll for changes: check focus, bounds, window list, document path, text, and document text.
    /// Fetches the window list once and passes it to all sub-checks.
    pub fn poll_for_changes(&mut self) {
        let windows = window_list::get_windows_for_pid(self.word_pid);
        self.check_for_window_changes(&windows);
        self.check_for_focus_change(&windows);
        self.check_for_bounds_change(&windows);
        self.check_document_path_changed();
        self.check_text_selection_changed();
        self.check_selection_bounds_end();
        self.check_document_text_changed();
    }

    /// Check for new/destroyed windows.
    fn check_for_window_changes(&mut self, current_windows: &[WindowListEntry]) {
        let mut current_ids: Vec<u32> = Vec::with_capacity(current_windows.len());

        for w in current_windows {
            current_ids.push(w.window_id);
        }

        // Check for new windows
        for w in current_windows {
            let is_new = !self.windows.contains_key(&w.window_id);
            if is_new {
                self.windows.insert(w.window_id, TrackedWindow {
                    is_emitted: false,
                    bounds: None,
                    document_path: None,
                });
            }

            let is_emitted = self.windows.get(&w.window_id).is_some_and(|tw| tw.is_emitted);
            if !is_emitted {
                let role = self.get_role_for_window(w.window_id);
                if role.as_deref() == Some("AXWindow") {
                    let window_info = self.create_window_info_from_entry(w, false);

                    let entry = self.windows.get_mut(&w.window_id).unwrap();
                    entry.is_emitted = true;
                    entry.bounds = Some((w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height));
                    entry.document_path = window_info.document_path.clone();

                    let app = self.app_info();
                    event_models::emit_window_event(EventType::WindowCreated, &app, window_info);
                }
            }
        }

        // Check for destroyed windows
        let destroyed: Vec<u32> = self
            .windows
            .keys()
            .copied()
            .filter(|id| !current_ids.contains(id))
            .collect();

        for wid in destroyed {
            self.windows.remove(&wid);
            self.emit_destroyed_event_for_window_id(wid);
            if wid == self.last_focused_window_id {
                self.last_focused_window_id = 0;
                self.last_content_bounds = None;
            }
        }
    }

    /// Check for focus changes on the target app's windows.
    fn check_for_focus_change(&mut self, current_windows: &[WindowListEntry]) {
        let app_element = match self.app_element.as_ref() {
            Some(el) => el,
            None => return,
        };

        // Only emit focus events if the target app is frontmost
        if !workspace::is_app_frontmost(&self.target_bundle_id) {
            return;
        }

        let focused = match accessibility::get_focused_window(app_element) {
            Some(w) => w,
            None => return,
        };

        // Use CGWindowID to identify the focused window instead of bounds matching
        let focused_window_id = match accessibility::get_window_id(&focused) {
            Some(id) => id,
            None => return,
        };

        if focused_window_id != self.last_focused_window_id {
            // Find the matching CGWindow entry for event data
            if let Some(w) = current_windows.iter().find(|w| w.window_id == focused_window_id) {
                // Register new observers first (unregisters old, finishing any pending
                // resize with the OLD focused window ID still set — correct!)
                let retained = focused.retain();
                self.register_resize_observers_for_window(retained);

                // NOW update the focused window ID
                self.last_focused_window_id = w.window_id;

                let window_info = self.create_window_info_from_entry(w, true);
                self.last_content_bounds = window_info.content_bounds.as_ref().map(|b| (b.x, b.y, b.width, b.height));
                let app = self.app_info();
                event_models::emit_window_event(EventType::WindowFocused, &app, window_info);

                // Trigger immediate document text read on focus
                self.on_window_focused(w.window_id);
            }
        }
    }

    /// Called when a window gains focus — triggers immediate document text read.
    fn on_window_focused(&mut self, window_id: u32) {
        let app_element = match self.app_element.as_ref() {
            Some(el) => el.retain(),
            None => return,
        };

        if let Some(ref mut tracker) = self.document_text {
            if let Some(change) = tracker.on_window_focused(&app_element, window_id) {
                let window_info = self.build_window_info_for_id(window_id);
                if let Some(window_info) = window_info {
                    let app = self.app_info();
                    event_models::emit_document_text_event(
                        &app,
                        window_info,
                        DocumentTextInfo {
                            file_path: change.file_path,
                            character_count: change.character_count,
                            byte_size: change.byte_size,
                        },
                    );
                }
            }
        }
    }

    /// Check for bounds changes via polling (detects programmatic moves).
    fn check_for_bounds_change(&mut self, current_windows: &[WindowListEntry]) {
        if self.last_focused_window_id == 0 {
            return;
        }

        for w in current_windows {
            if w.window_id != self.last_focused_window_id {
                continue;
            }

            let current = (w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height);

            if let Some(tw) = self.windows.get(&w.window_id) {
                if let Some(cached) = tw.bounds {
                    let changed = (current.0 - cached.0).abs() > BOUNDS_TOLERANCE
                        || (current.1 - cached.1).abs() > BOUNDS_TOLERANCE
                        || (current.2 - cached.2).abs() > BOUNDS_TOLERANCE
                        || (current.3 - cached.3).abs() > BOUNDS_TOLERANCE;

                    if changed {
                        if let Some(entry) = self.windows.get_mut(&w.window_id) {
                            entry.bounds = Some(current);
                        }
                        self.handle_window_bounds_changed();
                    }
                } else if let Some(entry) = self.windows.get_mut(&w.window_id) {
                    entry.bounds = Some(current);
                }
            }
            break;
        }
    }

    /// Check if the focused window's document path has changed; emit event if so.
    pub fn check_document_path_changed(&mut self) {
        let app_element = match self.app_element.as_ref() {
            Some(el) => el,
            None => return,
        };
        let focused = match accessibility::get_focused_window(app_element) {
            Some(w) => w,
            None => return,
        };
        let window_id = match accessibility::get_window_id(&focused) {
            Some(id) => id,
            None => return,
        };

        let current_doc_path = accessibility::get_document(&focused);

        let tracked = match self.windows.get_mut(&window_id) {
            Some(tw) => tw,
            None => return,
        };

        if tracked.document_path != current_doc_path {
            tracked.document_path = current_doc_path;

            let windows = window_list::get_windows_for_pid(self.word_pid);
            if let Some(entry) = windows.iter().find(|w| w.window_id == window_id) {
                let window_info = self.create_window_info_from_entry(entry, false);
                let app = self.app_info();
                event_models::emit_window_event(
                    EventType::WindowDocumentPathChanged,
                    &app,
                    window_info,
                );
            }
        }
    }

    /// Check for text selection changes in the focused UI element.
    fn check_text_selection_changed(&mut self) {
        let tracker = match self.text_selection.as_mut() {
            Some(t) => t,
            None => return,
        };
        let app_element = match self.app_element.as_ref() {
            Some(el) => el,
            None => return,
        };

        let focused_window_id = self.last_focused_window_id;
        if focused_window_id == 0 {
            return;
        }

        let change = match tracker.poll(app_element, focused_window_id) {
            Some(c) => c,
            None => return,
        };

        match change {
            TextSelectionChange::Selected {
                file_path,
                length,
                bounds,
            } => {
                // Force-finish any active bounds reposition before emitting Selected
                self.finish_selection_bounds_reposition();

                let window_info = match self.build_window_info_for_id(focused_window_id) {
                    Some(w) => w,
                    None => return,
                };
                let app = self.app_info();
                let selection = TextSelectionInfo {
                    file_path,
                    length,
                    bounds: bounds.map(|(x, y, w, h)| SelectionBounds {
                        x,
                        y,
                        width: w,
                        height: h,
                    }),
                };
                event_models::emit_text_selection_event(
                    EventType::WindowTextSelected,
                    &app,
                    window_info,
                    Some(selection),
                );
            }
            TextSelectionChange::Cleared => {
                // Force-finish any active bounds reposition before emitting Cleared
                self.finish_selection_bounds_reposition();

                let window_info = match self.build_window_info_for_id(focused_window_id) {
                    Some(w) => w,
                    None => return,
                };
                let app = self.app_info();
                event_models::emit_text_selection_event(
                    EventType::WindowTextSelectionCleared,
                    &app,
                    window_info,
                    None,
                );
            }
            TextSelectionChange::BoundsChanged => {
                self.handle_selection_bounds_change();
            }
        }
    }

    /// Check if selection bounds debounce has elapsed (called from main loop).
    pub fn check_selection_bounds_end(&mut self) {
        let tracker = match self.text_selection.as_mut() {
            Some(t) => t,
            None => return,
        };
        if let SelectionBoundsAction::EmitRepositioned =
            tracker.check_bounds_end(SELECTION_BOUNDS_DEBOUNCE_MS)
        {
            if let Some(bounds) = tracker.latest_bounds() {
                let focused_window_id = self.last_focused_window_id;
                let window_info = match self.build_window_info_for_id(focused_window_id) {
                    Some(w) => w,
                    None => return,
                };
                let app = self.app_info();
                let (x, y, w, h) = bounds;
                event_models::emit_selection_position_event(
                    EventType::WindowTextSelectionRepositioned,
                    &app,
                    window_info,
                    SelectionBounds {
                        x,
                        y,
                        width: w,
                        height: h,
                    },
                );
            }
        }
    }

    /// Handle a BoundsChanged signal: run debounce state machine, emit REPOSITIONING on first change.
    fn handle_selection_bounds_change(&mut self) {
        let tracker = match self.text_selection.as_mut() {
            Some(t) => t,
            None => return,
        };
        if let SelectionBoundsAction::EmitRepositioning = tracker.on_bounds_changed() {
            if let Some(bounds) = tracker.latest_bounds() {
                let focused_window_id = self.last_focused_window_id;
                let window_info = match self.build_window_info_for_id(focused_window_id) {
                    Some(w) => w,
                    None => return,
                };
                let app = self.app_info();
                let (x, y, w, h) = bounds;
                event_models::emit_selection_position_event(
                    EventType::WindowTextSelectionRepositioning,
                    &app,
                    window_info,
                    SelectionBounds {
                        x,
                        y,
                        width: w,
                        height: h,
                    },
                );
            }
        }
    }

    /// Fast bounds-only check called every main loop iteration (~100ms).
    /// Detects selection position changes without the expensive text content poll.
    pub fn check_selection_bounds_fast(&mut self) {
        let app_element = match self.app_element.as_ref() {
            Some(el) => el.retain(),
            None => return,
        };
        if self.last_focused_window_id == 0 {
            return;
        }
        let tracker = match self.text_selection.as_mut() {
            Some(t) => t,
            None => return,
        };
        let change = tracker.poll_bounds_only(&app_element);
        if let Some(TextSelectionChange::BoundsChanged) = change {
            self.handle_selection_bounds_change();
        }
    }

    /// Handle a scroll event detected by the CGEvent tap.
    /// Checks if the mouse is within the content area and emits REPOSITIONING immediately.
    pub fn on_scroll_event(&mut self) {
        if self.last_focused_window_id == 0 {
            return;
        }
        // Require valid content bounds — if not yet detected, don't emit
        let (cx, cy, cw, ch) = match self.last_content_bounds {
            Some(b) => b,
            None => return,
        };
        // NSEvent.mouseLocation uses AppKit coords (bottom-left origin)
        // Convert to Quartz coords (top-left origin) to match contentBounds
        let mouse_loc = objc2_app_kit::NSEvent::mouseLocation();
        let screen_height = core_graphics::display::CGDisplay::main().bounds().size.height;
        let mouse_x = mouse_loc.x;
        let mouse_y = screen_height - mouse_loc.y;
        if mouse_x < cx || mouse_x > cx + cw || mouse_y < cy || mouse_y > cy + ch {
            return; // Mouse is outside content area
        }
        self.last_scroll_time = Some(Instant::now());
        let tracker = match self.text_selection.as_mut() {
            Some(t) => t,
            None => return,
        };
        if let SelectionBoundsAction::EmitRepositioning = tracker.on_scroll_detected() {
            if let Some(bounds) = tracker.latest_bounds() {
                let focused_window_id = self.last_focused_window_id;
                let window_info = match self.build_window_info_for_id(focused_window_id) {
                    Some(w) => w,
                    None => return,
                };
                let app = self.app_info();
                let (x, y, w, h) = bounds;
                event_models::emit_selection_position_event(
                    EventType::WindowTextSelectionRepositioning,
                    &app,
                    window_info,
                    SelectionBounds {
                        x,
                        y,
                        width: w,
                        height: h,
                    },
                );
            }
        }
    }

    /// Keep the selection bounds debounce alive while scroll events are still arriving.
    /// Called every main loop iteration — bridges the gap between discrete scroll events
    /// so REPOSITIONED doesn't fire mid-scroll.
    pub fn extend_scroll_debounce(&mut self) {
        let recent = match self.last_scroll_time {
            Some(t) if t.elapsed().as_millis() < 250 => true,
            _ => false,
        };
        if !recent {
            return;
        }
        if let Some(ref mut tracker) = self.text_selection {
            tracker.extend_bounds_debounce();
        }
    }

    /// Force-finish any active selection bounds reposition, emitting the final event.
    fn finish_selection_bounds_reposition(&mut self) {
        let tracker = match self.text_selection.as_mut() {
            Some(t) => t,
            None => return,
        };
        if let SelectionBoundsAction::EmitRepositioned = tracker.force_finish_bounds() {
            if let Some(bounds) = tracker.latest_bounds() {
                let focused_window_id = self.last_focused_window_id;
                let window_info = match self.build_window_info_for_id(focused_window_id) {
                    Some(w) => w,
                    None => return,
                };
                let app = self.app_info();
                let (x, y, w, h) = bounds;
                event_models::emit_selection_position_event(
                    EventType::WindowTextSelectionRepositioned,
                    &app,
                    window_info,
                    SelectionBounds {
                        x,
                        y,
                        width: w,
                        height: h,
                    },
                );
            }
        }
    }

    /// Check for document text changes (poll character count, debounce, read full text).
    fn check_document_text_changed(&mut self) {
        let app_element = match self.app_element.as_ref() {
            Some(el) => el.retain(),
            None => return,
        };

        let focused_window_id = self.last_focused_window_id;

        let tracker = match self.document_text.as_mut() {
            Some(t) => t,
            None => return,
        };

        let change = match tracker.poll(&app_element, focused_window_id) {
            Some(c) => c,
            None => return,
        };

        let window_info = self.build_window_info_for_id(focused_window_id);
        let window_info = match window_info {
            Some(w) => w,
            None => return,
        };

        let app = self.app_info();
        event_models::emit_document_text_event(
            &app,
            window_info,
            DocumentTextInfo {
                file_path: change.file_path,
                character_count: change.character_count,
                byte_size: change.byte_size,
            },
        );
    }

    /// Handle bounds change: emit REPOSITIONING, start debounce.
    pub fn handle_window_bounds_changed(&mut self) {
        if let RepositionAction::EmitRepositioning = self.reposition.on_bounds_changed() {
            self.emit_resizing_event_for_focused_window();
        }
    }

    /// Check if resize debounce has elapsed (called from main loop).
    pub fn check_resize_end(&mut self) {
        if let RepositionAction::EmitRepositioned = self.reposition.check_end(RESIZE_DEBOUNCE_MS) {
            self.emit_resized_event_for_focused_window();
        }
    }

    /// Emit WINDOW_REPOSITIONING for the currently focused window.
    fn emit_resizing_event_for_focused_window(&self) {
        if self.last_focused_window_id == 0 {
            return;
        }
        let windows = window_list::get_windows_for_pid(self.word_pid);
        for w in &windows {
            if w.window_id == self.last_focused_window_id {
                let window_info = self.create_window_info_from_entry(w, false);
                let app = self.app_info();
                event_models::emit_window_event(EventType::WindowRepositioning, &app, window_info);
                break;
            }
        }
    }

    /// Emit WINDOW_REPOSITIONED for the currently focused window.
    fn emit_resized_event_for_focused_window(&mut self) {
        if self.last_focused_window_id == 0 {
            return;
        }
        let windows = window_list::get_windows_for_pid(self.word_pid);
        for w in &windows {
            if w.window_id == self.last_focused_window_id {
                // Update cached bounds
                if let Some(entry) = self.windows.get_mut(&w.window_id) {
                    entry.bounds = Some((w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height));
                }
                let window_info = self.create_window_info_from_entry(w, true);
                self.last_content_bounds = window_info.content_bounds.as_ref().map(|b| (b.x, b.y, b.width, b.height));
                let app = self.app_info();
                event_models::emit_window_event(EventType::WindowRepositioned, &app, window_info);
                break;
            }
        }
    }

    /// Emit WINDOW_DESTROYED events for all tracked windows (on app terminate).
    fn emit_destroyed_events_for_all_tracked_windows(&mut self) {
        let ids: Vec<u32> = self.windows.keys().copied().collect();
        for wid in ids {
            self.emit_destroyed_event_for_window_id(wid);
        }
        self.windows.clear();
    }

    /// Emit a WINDOW_DESTROYED event for a specific window ID.
    fn emit_destroyed_event_for_window_id(&self, window_id: u32) {
        let app = self.app_info();
        let window_info = WindowInfoOutput {
            id: window_id.to_string(),
            title: None,
            bounds: None,
            document_path: None,
            content_bounds: None,
        };
        event_models::emit_window_event(EventType::WindowDestroyed, &app, window_info);
    }

    /// Clean up all temp files (on shutdown or app terminate).
    fn cleanup_all_temp_files(&self) {
        if let Some(ref tracker) = self.text_selection {
            tracker.cleanup_all();
        }
        if let Some(ref tracker) = self.document_text {
            tracker.cleanup_all();
        }
    }

    /// Get the AXRole for a window identified by its CGWindowID.
    fn get_role_for_window(&self, window_id: u32) -> Option<String> {
        let ax_window = self.find_ax_window_for_id(window_id)?;
        accessibility::get_role(&ax_window)
    }

    /// Find an AX window element matching a CGWindowID.
    fn find_ax_window_for_id(&self, window_id: u32) -> Option<SafeAXUIElement> {
        let app_element = self.app_element.as_ref()?;
        let ax_windows = accessibility::get_ax_windows(app_element);

        for ax_win in ax_windows {
            if accessibility::get_window_id(&ax_win) == Some(window_id) {
                return Some(ax_win);
            }
        }

        None
    }

    /// Create a WindowInfoOutput from a CGWindow entry, enriched with AX attributes.
    /// When `include_content_bounds` is true, the content area child is located and
    /// its bounds are included (used for WINDOW_FOCUSED and WINDOW_REPOSITIONED).
    fn create_window_info_from_entry(&self, entry: &WindowListEntry, include_content_bounds: bool) -> WindowInfoOutput {
        let mut document_path = None;
        let mut content_bounds = None;

        if let Some(ax_window) = self.find_ax_window_for_id(entry.window_id) {
            document_path = accessibility::get_document(&ax_window);

            if include_content_bounds {
                if let Some(content_area) = accessibility::find_content_area_child(&ax_window, self.content_area_role.as_deref()) {
                    if let Some(rect) = accessibility::get_element_bounds(&content_area) {
                        content_bounds = Some(WindowBounds {
                            x: rect.origin.x,
                            y: rect.origin.y,
                            width: rect.size.width,
                            height: rect.size.height,
                        });
                    }
                }
            }
        }

        WindowInfoOutput {
            id: entry.window_id.to_string(),
            title: entry.name.clone(),
            bounds: Some(WindowBounds {
                x: entry.bounds.x,
                y: entry.bounds.y,
                width: entry.bounds.width,
                height: entry.bounds.height,
            }),
            document_path,
            content_bounds,
        }
    }

    /// Build WindowInfoOutput for a window ID using the current window list.
    fn build_window_info_for_id(&self, window_id: u32) -> Option<WindowInfoOutput> {
        if window_id == 0 {
            return None;
        }
        let windows = window_list::get_windows_for_pid(self.word_pid);
        windows
            .iter()
            .find(|w| w.window_id == window_id)
            .map(|w| self.create_window_info_from_entry(w, false))
    }

    /// Schedule a deferred window check (100ms after AX notification).
    pub fn schedule_deferred_window_check(&mut self) {
        self.deferred_check.schedule();
    }

    /// Check if deferred window check is ready to execute.
    pub fn check_deferred_window_check(&mut self) {
        if self.deferred_check.should_execute(DEFERRED_CHECK_DELAY_MS) {
            let windows = window_list::get_windows_for_pid(self.word_pid);
            self.check_for_window_changes(&windows);
        }
    }
}

/// AX observer callback (extern "C" function).
/// Routes notifications to the appropriate handler on the WindowMonitor.
pub unsafe extern "C" fn ax_observer_callback(
    _observer: accessibility::AXObserverRef,
    _element: accessibility::AXUIElementRef,
    notification_name: core_foundation_sys::string::CFStringRef,
    context: *mut c_void,
) {
    if context.is_null() {
        return;
    }

    let monitor = &mut *(context as *mut WindowMonitor);

    let notif: core_foundation::string::CFString = TCFType::wrap_under_get_rule(notification_name);
    let notif_str = notif.to_string();

    match notif_str.as_str() {
        "AXWindowCreated" | "AXUIElementDestroyed" => {
            monitor.schedule_deferred_window_check();
        }
        "AXFocusedWindowChanged" => {
            let windows = window_list::get_windows_for_pid(monitor.word_pid);
            monitor.check_for_focus_change(&windows);
            monitor.check_for_window_changes(&windows);
        }
        "AXMoved" | "AXResized" => {
            monitor.handle_window_bounds_changed();
        }
        "AXTitleChanged" => {
            monitor.check_document_path_changed();
        }
        _ => {}
    }
}
