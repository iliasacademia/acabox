use objc2_app_kit::NSPanel;
use raw_window_handle::{HasWindowHandle, RawWindowHandle, WindowHandle};
use std::ptr::NonNull;
use wry::{Rect, WebView, WebViewBuilder};

/// Wrapper that implements HasWindowHandle for an NSPanel's content view,
/// allowing wry to attach a WKWebView to it.
struct PanelHandle {
    ns_view: NonNull<std::ffi::c_void>,
}

impl HasWindowHandle for PanelHandle {
    fn window_handle(
        &self,
    ) -> Result<WindowHandle<'_>, raw_window_handle::HandleError> {
        let handle = raw_window_handle::AppKitWindowHandle::new(self.ns_view);
        // SAFETY: the NSView pointer is valid for the lifetime of the panel
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::AppKit(handle)) })
    }
}

/// Create a WKWebView (via wry) inside the given NSPanel and load the URL.
pub fn create_webview(panel: &NSPanel, url: &str) -> Result<WebView, String> {
    let content_view = panel.contentView().ok_or("panel has no content view")?;
    let view_ptr: *const objc2_app_kit::NSView = &*content_view;
    let ns_view =
        NonNull::new(view_ptr as *mut std::ffi::c_void).ok_or("content view is null")?;

    let handle = PanelHandle { ns_view };

    let frame = panel.frame();

    let webview = WebViewBuilder::new()
        .with_url(url)
        .with_transparent(true)
        .with_bounds(Rect {
            position: wry::dpi::Position::Logical(wry::dpi::LogicalPosition::new(0.0, 0.0)),
            size: wry::dpi::Size::Logical(wry::dpi::LogicalSize::new(
                frame.size.width,
                frame.size.height,
            )),
        })
        .build_as_child(&handle)
        .map_err(|e| format!("wry build failed: {e}"))?;

    Ok(webview)
}
