use crate::accessibility::{self, SafeAXObserver, SafeAXUIElement};
use crate::event_models::{self, AppInfoOutput, WindowBounds, WindowInfoOutput};
use crate::event_types::EventType;
use crate::window_list;
use crate::workspace;
use core_foundation::base::TCFType;
use core_foundation::runloop::{CFRunLoop, CFRunLoopSource};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const BOUNDS_TOLERANCE: f64 = 2.0;

// Safety: WindowMonitor is only accessed from the main thread.
// The raw pointers inside (AXUIElementRef, AXObserverRef) are only valid on the main thread,
// which is enforced by the CFRunLoop-based architecture.
unsafe impl Send for WindowMonitor {}
unsafe impl Sync for WindowMonitor {}

/// Core state for the window monitor.
pub struct WindowMonitor {
    pub target_bundle_id: String,
    pub app_display_name: Option<String>,
    pub word_pid: i32,

    /// Windows that emitted CREATED/EXISTING (role=AXWindow).
    pub tracked_window_ids: HashSet<u32>,
    /// All windows seen (for destroy detection).
    pub all_known_window_ids: HashSet<u32>,
    /// Cached bounds for resize/move change detection.
    pub window_bounds_cache: HashMap<u32, (f64, f64, f64, f64)>,

    /// AX observer for the target app.
    pub ax_observer: Option<SafeAXObserver>,
    /// AXUIElement for the target app.
    pub app_element: Option<SafeAXUIElement>,
    /// Window element with resize/move observers attached.
    pub observed_window_element: Option<SafeAXUIElement>,

    /// Whether the focused window is currently being repositioned.
    pub is_resizing: bool,
    /// Timestamp of last bounds change for debounce.
    pub last_bounds_change_time: Option<Instant>,
    /// Last focused window ID.
    pub last_focused_window_id: u32,

    /// Deferred window check after AX notification.
    pub pending_window_check: bool,
    pub pending_check_time: Option<Instant>,

    /// Run loop source to keep alive.
    pub runloop_source: Option<CFRunLoopSource>,

    /// Workspace observer tokens (must be kept alive).
    pub workspace_tokens: Option<workspace::WorkspaceObserverTokens>,

    /// Flag to indicate monitoring is active.
    pub is_monitoring: bool,
}

impl WindowMonitor {
    pub fn new(bundle_id: &str) -> Self {
        WindowMonitor {
            target_bundle_id: bundle_id.to_string(),
            app_display_name: None,
            word_pid: 0,
            tracked_window_ids: HashSet::new(),
            all_known_window_ids: HashSet::new(),
            window_bounds_cache: HashMap::new(),
            ax_observer: None,
            app_element: None,
            observed_window_element: None,
            is_resizing: false,
            last_bounds_change_time: None,
            last_focused_window_id: 0,
            pending_window_check: false,
            pending_check_time: None,
            runloop_source: None,
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
    pub fn start_monitoring(monitor: &Arc<Mutex<WindowMonitor>>, should_exit: &Arc<AtomicBool>) {
        {
            let mut m = monitor.lock().unwrap();
            if m.is_monitoring {
                return;
            }
            m.is_monitoring = true;
            eprintln!("Starting window monitor for {}...", m.target_bundle_id);
        }

        // Register workspace notifications
        let monitor_clone = Arc::clone(monitor);
        let bundle_id = monitor.lock().unwrap().target_bundle_id.clone();
        let should_exit_clone = Arc::clone(should_exit);

        let callback = Arc::new(Mutex::new(
            move |notif: workspace::WorkspaceNotification| {
                if should_exit_clone.load(Ordering::Relaxed) {
                    return;
                }
                let Some(ref bid) = notif.bundle_id else {
                    return;
                };
                if bid != &bundle_id {
                    return;
                }
                let mut m = monitor_clone.lock().unwrap();
                match notif.event {
                    workspace::WorkspaceEvent::AppLaunched => {
                        if m.app_display_name.is_none() {
                            m.app_display_name = notif.app_name.clone();
                        }
                        m.word_pid = notif.pid;
                        event_models::emit_app_event(EventType::AppLaunched, &m.app_info());
                        m.attach_to_app();
                    }
                    workspace::WorkspaceEvent::AppTerminated => {
                        m.emit_destroyed_events_for_all_tracked_windows();
                        event_models::emit_app_event(EventType::AppTerminated, &m.app_info());
                        m.detach_from_app();
                    }
                    workspace::WorkspaceEvent::AppActivated => {
                        event_models::emit_app_event(EventType::AppFocused, &m.app_info());
                    }
                    workspace::WorkspaceEvent::AppDeactivated => {
                        event_models::emit_app_event(EventType::AppUnfocused, &m.app_info());
                    }
                }
            },
        ));

        let tokens = workspace::register_workspace_notifications(callback);
        monitor.lock().unwrap().workspace_tokens = Some(tokens);

        // Check if target app is already running
        let target = monitor.lock().unwrap().target_bundle_id.clone();
        if let Some((pid, name)) = workspace::find_running_app(&target) {
            let mut m = monitor.lock().unwrap();
            m.word_pid = pid;
            if m.app_display_name.is_none() {
                m.app_display_name = Some(name);
            }
            eprintln!(
                "{} is already running (PID: {})",
                m.app_display_name.as_deref().unwrap_or(&m.target_bundle_id),
                pid
            );
            event_models::emit_app_event(EventType::AppExisting, &m.app_info());
            m.attach_to_app();
        }
    }

    /// Stop monitoring: remove all observers and clean up.
    pub fn stop_monitoring(&mut self) {
        if !self.is_monitoring {
            return;
        }
        self.is_monitoring = false;
        eprintln!("Stopping window monitor...");

        self.workspace_tokens = None;
        self.detach_from_app();
    }

    /// Attach to the target app: create AX observer and enumerate windows.
    fn attach_to_app(&mut self) {
        if self.word_pid == 0 {
            return;
        }

        // Create AXUIElement for the app
        let app_element = match accessibility::create_app_element(self.word_pid) {
            Some(el) => el,
            None => {
                eprintln!("Failed to create AXUIElement for app");
                return;
            }
        };

        // Create AX observer
        let observer = match accessibility::create_observer(self.word_pid, ax_observer_callback) {
            Some(obs) => obs,
            None => {
                eprintln!("Failed to create AXObserver");
                return;
            }
        };

        // Add notifications for window events on the app element
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

        // Add observer to run loop
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

        // Enumerate existing windows
        self.enumerate_existing_windows();
    }

    /// Detach from app: clean up observers and state.
    fn detach_from_app(&mut self) {
        // Unregister resize observers
        self.unregister_resize_observers();

        // Remove run loop source
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
        self.is_resizing = false;
        self.last_bounds_change_time = None;
        self.tracked_window_ids.clear();
        self.all_known_window_ids.clear();
        self.window_bounds_cache.clear();
        self.pending_window_check = false;
        self.pending_check_time = None;
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

        self.observed_window_element = Some(window_element);
    }

    /// Unregister move/resize observers from the currently observed window.
    fn unregister_resize_observers(&mut self) {
        if let (Some(ref element), Some(ref observer)) =
            (&self.observed_window_element, &self.ax_observer)
        {
            {
                observer.remove_notification(element, accessibility::k_ax_moved_notification());
                observer.remove_notification(element, accessibility::k_ax_resized_notification());
            }
        }
        self.observed_window_element = None;

        // If we were resizing, emit the final event
        if self.is_resizing {
            self.finish_resizing();
        }
    }

    /// Enumerate existing windows and emit WINDOW_EXISTING events.
    fn enumerate_existing_windows(&mut self) {
        let windows = window_list::get_windows_for_pid(self.word_pid);
        let mut emitted_count = 0;

        for w in &windows {
            self.all_known_window_ids.insert(w.window_id);

            // Only emit WINDOW_EXISTING for "AXWindow" role
            let role = self.get_role_for_window_at_bounds(w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height);
            if role.as_deref() != Some("AXWindow") {
                continue;
            }

            self.tracked_window_ids.insert(w.window_id);
            self.window_bounds_cache
                .insert(w.window_id, (w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height));
            emitted_count += 1;

            let window_info = self.create_window_info_from_entry(w);
            let app = self.app_info();
            event_models::emit_window_event(EventType::WindowExisting, &app, window_info);
        }

        eprintln!(
            "Found {} windows, emitted {} WINDOW_EXISTING events",
            windows.len(),
            emitted_count
        );
    }

    /// Poll for changes: check focus, bounds, and window list.
    pub fn poll_for_changes(&mut self) {
        self.check_for_window_changes();
        self.check_for_focus_change();
        self.check_for_bounds_change();
    }

    /// Check for new/destroyed windows.
    pub fn check_for_window_changes(&mut self) {
        let current_windows = window_list::get_windows_for_pid(self.word_pid);
        let mut current_ids: HashSet<u32> = HashSet::new();

        for w in &current_windows {
            current_ids.insert(w.window_id);
        }

        // Check for new windows
        for w in &current_windows {
            let is_new = !self.all_known_window_ids.contains(&w.window_id);
            if is_new {
                self.all_known_window_ids.insert(w.window_id);
            }

            if !self.tracked_window_ids.contains(&w.window_id) {
                let role = self.get_role_for_window_at_bounds(
                    w.bounds.x,
                    w.bounds.y,
                    w.bounds.width,
                    w.bounds.height,
                );
                if role.as_deref() == Some("AXWindow") {
                    self.tracked_window_ids.insert(w.window_id);
                    self.window_bounds_cache
                        .insert(w.window_id, (w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height));

                    let window_info = self.create_window_info_from_entry(w);
                    let app = self.app_info();
                    event_models::emit_window_event(EventType::WindowCreated, &app, window_info);
                }
            }
        }

        // Check for destroyed windows
        let destroyed: Vec<u32> = self
            .all_known_window_ids
            .difference(&current_ids)
            .copied()
            .collect();

        for wid in destroyed {
            self.all_known_window_ids.remove(&wid);
            self.tracked_window_ids.remove(&wid);
            self.window_bounds_cache.remove(&wid);
            self.emit_destroyed_event_for_window_id(wid);
        }
    }

    /// Check for focus changes on the target app's windows.
    pub fn check_for_focus_change(&mut self) {
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

        let (fx, fy) = match accessibility::get_position(&focused) {
            Some(p) => p,
            None => return,
        };
        let (fw, fh) = match accessibility::get_size(&focused) {
            Some(s) => s,
            None => return,
        };

        // Find matching CGWindow by bounds
        let windows = window_list::get_windows_for_pid(self.word_pid);
        for w in &windows {
            if bounds_match(
                w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height,
                fx, fy, fw, fh,
            ) {
                if w.window_id != self.last_focused_window_id {
                    // Register new observers first (unregisters old, finishing any pending
                    // resize with the OLD focused window ID still set — correct!)
                    let retained = focused.retain();
                    self.register_resize_observers_for_window(retained);

                    // NOW update the focused window ID
                    self.last_focused_window_id = w.window_id;

                    let window_info = self.create_window_info_from_entry(w);
                    let app = self.app_info();
                    event_models::emit_window_event(EventType::WindowFocused, &app, window_info);
                }
                break;
            }
        }
    }

    /// Check for bounds changes via polling (detects programmatic moves).
    fn check_for_bounds_change(&mut self) {
        if self.last_focused_window_id == 0 {
            return;
        }

        let windows = window_list::get_windows_for_pid(self.word_pid);
        for w in &windows {
            if w.window_id != self.last_focused_window_id {
                continue;
            }

            let current = (w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height);

            if let Some(cached) = self.window_bounds_cache.get(&w.window_id) {
                let changed = (current.0 - cached.0).abs() > BOUNDS_TOLERANCE
                    || (current.1 - cached.1).abs() > BOUNDS_TOLERANCE
                    || (current.2 - cached.2).abs() > BOUNDS_TOLERANCE
                    || (current.3 - cached.3).abs() > BOUNDS_TOLERANCE;

                if changed {
                    self.window_bounds_cache.insert(w.window_id, current);
                    self.handle_window_bounds_changed();
                }
            } else {
                self.window_bounds_cache.insert(w.window_id, current);
            }
            break;
        }
    }

    /// Handle bounds change: emit REPOSITIONING, start debounce.
    pub fn handle_window_bounds_changed(&mut self) {
        if !self.is_resizing {
            self.is_resizing = true;
            self.emit_resizing_event_for_focused_window();
        }
        self.last_bounds_change_time = Some(Instant::now());
    }

    /// Check if resize debounce has elapsed (called from main loop).
    pub fn check_resize_end(&mut self) {
        if !self.is_resizing {
            return;
        }
        if let Some(last_change) = self.last_bounds_change_time {
            if last_change.elapsed().as_millis() >= 150 {
                self.finish_resizing();
            }
        }
    }

    /// Finish resizing: emit REPOSITIONED event.
    fn finish_resizing(&mut self) {
        if !self.is_resizing {
            return;
        }
        self.is_resizing = false;
        self.last_bounds_change_time = None;
        self.emit_resized_event_for_focused_window();
    }

    /// Emit WINDOW_REPOSITIONING for the currently focused window.
    fn emit_resizing_event_for_focused_window(&self) {
        if self.last_focused_window_id == 0 {
            return;
        }
        let windows = window_list::get_windows_for_pid(self.word_pid);
        for w in &windows {
            if w.window_id == self.last_focused_window_id {
                let window_info = self.create_window_info_from_entry(w);
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
                self.window_bounds_cache.insert(
                    w.window_id,
                    (w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height),
                );
                let window_info = self.create_window_info_from_entry(w);
                let app = self.app_info();
                event_models::emit_window_event(EventType::WindowRepositioned, &app, window_info);
                break;
            }
        }
    }

    /// Emit WINDOW_DESTROYED events for all tracked windows (on app terminate).
    fn emit_destroyed_events_for_all_tracked_windows(&mut self) {
        let ids: Vec<u32> = self.all_known_window_ids.iter().copied().collect();
        for wid in ids {
            self.emit_destroyed_event_for_window_id(wid);
        }
        self.all_known_window_ids.clear();
        self.tracked_window_ids.clear();
    }

    /// Emit a WINDOW_DESTROYED event for a specific window ID.
    fn emit_destroyed_event_for_window_id(&self, window_id: u32) {
        let app = self.app_info();
        let window_info = WindowInfoOutput {
            id: window_id.to_string(),
            title: None,
            bounds: None,
            document_path: None,
        };
        event_models::emit_window_event(EventType::WindowDestroyed, &app, window_info);
    }

    /// Find an AXWindow matching the given bounds and return its role.
    fn get_role_for_window_at_bounds(
        &self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Option<String> {
        let ax_window = self.find_ax_window_for_bounds(x, y, w, h)?;
        accessibility::get_role(&ax_window)
    }

    /// Find an AX window element matching the given CGWindow bounds.
    fn find_ax_window_for_bounds(
        &self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Option<SafeAXUIElement> {
        let app_element = self.app_element.as_ref()?;
        let ax_windows = accessibility::get_ax_windows(app_element);

        for ax_win in ax_windows {
            if let Some((ax, ay, aw, ah)) = accessibility::get_bounds(&ax_win) {
                if bounds_match(x, y, w, h, ax, ay, aw, ah) {
                    return Some(ax_win);
                }
            }
        }

        None
    }

    /// Create a WindowInfoOutput from a CGWindow entry, enriched with AX attributes.
    fn create_window_info_from_entry(&self, entry: &window_list::WindowListEntry) -> WindowInfoOutput {
        let mut document_path = None;

        // Try to find matching AX window for document path
        if let Some(ax_window) = self.find_ax_window_for_bounds(
            entry.bounds.x,
            entry.bounds.y,
            entry.bounds.width,
            entry.bounds.height,
        ) {
            document_path = accessibility::get_document(&ax_window);
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
        }
    }

    /// Schedule a deferred window check (100ms after AX notification).
    pub fn schedule_deferred_window_check(&mut self) {
        self.pending_window_check = true;
        self.pending_check_time = Some(Instant::now());
    }

    /// Check if deferred window check is ready to execute.
    pub fn check_deferred_window_check(&mut self) {
        if !self.pending_window_check {
            return;
        }
        if let Some(check_time) = self.pending_check_time {
            if check_time.elapsed().as_millis() >= 100 {
                self.pending_window_check = false;
                self.pending_check_time = None;
                self.check_for_window_changes();
            }
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
        "AXWindowCreated" => {
            // Defer window check by 100ms to allow window to initialize
            monitor.schedule_deferred_window_check();
        }
        "AXUIElementDestroyed" => {
            // Defer window check by 100ms
            monitor.schedule_deferred_window_check();
        }
        "AXFocusedWindowChanged" => {
            monitor.check_for_focus_change();
            monitor.check_for_window_changes();
        }
        "AXMoved" | "AXResized" => {
            monitor.handle_window_bounds_changed();
        }
        _ => {}
    }
}

/// Check if two bounds match within tolerance.
fn bounds_match(
    x1: f64, y1: f64, w1: f64, h1: f64,
    x2: f64, y2: f64, w2: f64, h2: f64,
) -> bool {
    (x1 - x2).abs() < BOUNDS_TOLERANCE
        && (y1 - y2).abs() < BOUNDS_TOLERANCE
        && (w1 - w2).abs() < BOUNDS_TOLERANCE
        && (h1 - h2).abs() < BOUNDS_TOLERANCE
}
