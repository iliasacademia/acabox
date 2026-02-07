use std::collections::HashMap;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::NSPanel;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use wry::WebView;

use crate::desired_state::{DesiredState, WebviewEntryState, WebviewFrame};
use crate::panel::create_panel;
use crate::responses::Response;
use crate::webview::create_webview;

struct WebViewEntry {
    panel: Retained<NSPanel>,
    _webview: WebView,
    url: String,
    visible: bool,
    frame: WebviewFrame,
}

pub struct Manager {
    entries: HashMap<String, WebViewEntry>,
    mtm: MainThreadMarker,
}

impl Manager {
    pub fn new(mtm: MainThreadMarker) -> Self {
        Self {
            entries: HashMap::new(),
            mtm,
        }
    }

    pub fn reconcile(&mut self, desired: &DesiredState) {
        // 1. Destroy entries not in desired state
        let to_destroy: Vec<String> = self
            .entries
            .keys()
            .filter(|id| !desired.contains_key(*id))
            .cloned()
            .collect();

        for id in to_destroy {
            self.destroy(&id);
        }

        // 2. Create new entries and update existing ones
        for (id, entry_state) in desired {
            if let Some(existing) = self.entries.get(id) {
                // Entry exists — check what changed
                if existing.url != entry_state.url {
                    // URL changed → destroy and recreate
                    self.destroy(id);
                    self.create(id, entry_state);
                } else {
                    // Same URL — update frame and visibility
                    self.update(id, entry_state);
                }
            } else {
                // New entry
                self.create(id, entry_state);
            }
        }
    }

    fn create(&mut self, id: &str, state: &WebviewEntryState) {
        let frame = NSRect::new(
            NSPoint::new(state.frame.x, state.frame.y),
            NSSize::new(state.frame.width, state.frame.height),
        );
        let panel = create_panel(self.mtm, frame);

        match create_webview(&panel, &state.url) {
            Ok(webview) => {
                if state.visible {
                    panel.orderFrontRegardless();
                }
                self.entries.insert(
                    id.to_string(),
                    WebViewEntry {
                        panel,
                        _webview: webview,
                        url: state.url.clone(),
                        visible: state.visible,
                        frame: state.frame.clone(),
                    },
                );
                Response::ok("CREATE", id).emit();
                if state.visible {
                    Response::ok("SHOW", id).emit();
                }
            }
            Err(e) => {
                Response::error("CREATE", id, e).emit();
            }
        }
    }

    fn update(&mut self, id: &str, desired: &WebviewEntryState) {
        let existing = match self.entries.get_mut(id) {
            Some(e) => e,
            None => return,
        };

        let frame_changed = existing.frame != desired.frame;
        let visibility_changed = existing.visible != desired.visible;

        if !frame_changed && !visibility_changed {
            return; // No-op
        }

        // Reposition before show to avoid flicker
        if frame_changed {
            let frame = NSRect::new(
                NSPoint::new(desired.frame.x, desired.frame.y),
                NSSize::new(desired.frame.width, desired.frame.height),
            );
            existing.panel.setFrame_display(frame, true);
            existing.frame = desired.frame.clone();
            Response::ok("REPOSITION", id).emit();
        }

        if visibility_changed {
            if desired.visible {
                existing.panel.orderFrontRegardless();
                Response::ok("SHOW", id).emit();
            } else {
                existing.panel.orderOut(None);
                Response::ok("HIDE", id).emit();
            }
            existing.visible = desired.visible;
        }
    }

    fn destroy(&mut self, id: &str) {
        if let Some(entry) = self.entries.remove(id) {
            entry.panel.orderOut(None);
            entry.panel.close();
            Response::ok("DESTROY", id).emit();
        }
    }
}
