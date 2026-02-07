use objc2::rc::{Allocated, Retained};
use objc2::runtime::NSObject;
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use crate::debug::debug_log;
use crate::panel::KeyablePanel;
use objc2_app_kit::{NSAutoresizingMaskOptions, NSEvent, NSView};
use objc2_foundation::{NSNumber, NSRect, NSString, NSURL, NSURLRequest};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

define_class!(
    #[unsafe(super(WKWebView, NSView, objc2_app_kit::NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AcceptingWebView"]
    pub struct AcceptingWebView;

    impl AcceptingWebView {
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            crate::debug::log("AcceptingWebView: acceptsFirstMouse called → true");
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let loc = event.locationInWindow();
            crate::debug::log(&format!(
                "AcceptingWebView: mouseDown at ({:.1}, {:.1})",
                loc.x, loc.y
            ));
            unsafe { msg_send![super(self), mouseDown: event] }
        }
    }
);

impl AcceptingWebView {
    fn init_with_frame_configuration(
        this: Allocated<Self>,
        frame: NSRect,
        configuration: &WKWebViewConfiguration,
    ) -> Retained<Self> {
        let this = this.set_ivars(());
        unsafe { msg_send![super(this), initWithFrame: frame, configuration: configuration] }
    }
}

/// Create a WKWebView subclass inside the given NSPanel and load the URL.
/// Handles transparency (drawsBackground=NO, clear layer) and click-through
/// (acceptsFirstMouse: returns YES) which wry cannot provide.
pub fn create_webview(
    mtm: MainThreadMarker,
    panel: &KeyablePanel,
    url: &str,
) -> Result<Retained<AcceptingWebView>, String> {
    let content_view = panel.contentView().ok_or("panel has no content view")?;
    let frame = content_view.frame();

    // Configuration
    let config = unsafe { WKWebViewConfiguration::new(mtm) };

    // Create our subclassed WKWebView
    let webview = AcceptingWebView::init_with_frame_configuration(mtm.alloc(), frame, &config);

    // Autoresize with parent
    webview.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewHeightSizable,
    );

    // Transparency: disable drawsBackground via KVC
    let key = NSString::from_str("drawsBackground");
    let no = NSNumber::numberWithBool(false);
    unsafe {
        let _: () = msg_send![&webview, setValue: &*no, forKey: &*key];
    }

    // Layer-backed with clear background (typed APIs)
    webview.setWantsLayer(true);
    if let Some(layer) = webview.layer() {
        let cg_color = objc2_app_kit::NSColor::clearColor().CGColor();
        layer.setBackgroundColor(Some(&cg_color));
    }

    // Official WKWebView API for under-page transparency (macOS 12+)
    unsafe {
        webview.setUnderPageBackgroundColor(Some(&objc2_app_kit::NSColor::clearColor()));
    }

    // Load the URL
    let ns_url = NSURL::URLWithString(&NSString::from_str(url)).ok_or("invalid URL")?;
    let request = NSURLRequest::requestWithURL(&ns_url);
    unsafe {
        webview.loadRequest(&request);
    }

    // Add as subview
    content_view.addSubview(&webview);

    debug_log!(
        "create_webview: url={}, frame=({:.0},{:.0},{:.0},{:.0})",
        url, frame.origin.x, frame.origin.y, frame.size.width, frame.size.height
    );

    Ok(webview)
}
