use std::collections::HashMap;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::NSPanel;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use wry::WebView;

use crate::commands::Command;
use crate::panel::create_panel;
use crate::responses::Response;
use crate::webview::create_webview;

struct WebViewEntry {
    panel: Retained<NSPanel>,
    _webview: WebView,
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

    pub fn handle_command(&mut self, cmd: &Command) {
        match cmd {
            Command::CREATE {
                id,
                url,
                x,
                y,
                width,
                height,
            } => self.create(id, url, *x, *y, *width, *height),
            Command::SHOW { id } => self.show(id),
            Command::HIDE { id } => self.hide(id),
            Command::REPOSITION {
                id,
                x,
                y,
                width,
                height,
            } => self.reposition(id, *x, *y, *width, *height),
            Command::DESTROY { id } => self.destroy(id),
        }
    }

    fn create(&mut self, id: &str, url: &str, x: f64, y: f64, width: f64, height: f64) {
        if self.entries.contains_key(id) {
            Response::error("CREATE", id, "Webview already exists").emit();
            return;
        }

        let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
        let panel = create_panel(self.mtm, frame);

        match create_webview(&panel, url) {
            Ok(webview) => {
                self.entries.insert(
                    id.to_string(),
                    WebViewEntry {
                        panel,
                        _webview: webview,
                    },
                );
                Response::ok("CREATE", id).emit();
            }
            Err(e) => {
                Response::error("CREATE", id, e).emit();
            }
        }
    }

    fn show(&self, id: &str) {
        match self.entries.get(id) {
            Some(entry) => {
                entry.panel.orderFrontRegardless();
                Response::ok("SHOW", id).emit();
            }
            None => {
                Response::error("SHOW", id, "Webview not found").emit();
            }
        }
    }

    fn hide(&self, id: &str) {
        match self.entries.get(id) {
            Some(entry) => {
                entry.panel.orderOut(None);
                Response::ok("HIDE", id).emit();
            }
            None => {
                Response::error("HIDE", id, "Webview not found").emit();
            }
        }
    }

    fn reposition(&self, id: &str, x: f64, y: f64, width: f64, height: f64) {
        match self.entries.get(id) {
            Some(entry) => {
                let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
                entry.panel.setFrame_display(frame, true);
                Response::ok("REPOSITION", id).emit();
            }
            None => {
                Response::error("REPOSITION", id, "Webview not found").emit();
            }
        }
    }

    fn destroy(&mut self, id: &str) {
        match self.entries.remove(id) {
            Some(entry) => {
                entry.panel.orderOut(None);
                entry.panel.close();
                Response::ok("DESTROY", id).emit();
            }
            None => {
                Response::error("DESTROY", id, "Webview not found").emit();
            }
        }
    }
}
