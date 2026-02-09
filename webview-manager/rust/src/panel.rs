use objc2::rc::{Allocated, Retained};
use objc2::runtime::NSObject;
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use crate::debug::debug_log;
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSFloatingWindowLevel, NSPanel, NSResponder, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::NSRect;

define_class!(
    /// NSPanel subclass that returns YES for canBecomeKeyWindow.
    /// NonactivatingPanel defaults to NO, which prevents WKWebView from
    /// forwarding mouse events to its web content process.
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "KeyablePanel"]
    pub struct KeyablePanel;

    impl KeyablePanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            crate::debug::log("KeyablePanel: canBecomeKeyWindow called → true");
            true
        }
    }
);

impl KeyablePanel {
    fn init_with_content_rect(
        this: Allocated<Self>,
        frame: NSRect,
        style: NSWindowStyleMask,
        backing: NSBackingStoreType,
        defer: bool,
    ) -> Retained<Self> {
        let this = this.set_ivars(());
        unsafe {
            msg_send![super(this), initWithContentRect: frame, styleMask: style, backing: backing, defer: defer]
        }
    }
}

/// Create a non-activating NSPanel matching the config from BasePopupWindow.mm.
///
/// Style: borderless + non-activating panel, transparent background, floating level + 1,
/// no shadow, visible on all spaces, never steals focus, canBecomeKeyWindow = YES.
pub fn create_panel(mtm: MainThreadMarker, frame: NSRect) -> Retained<KeyablePanel> {
    let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;

    let panel = KeyablePanel::init_with_content_rect(
        mtm.alloc(),
        frame,
        style,
        NSBackingStoreType::Buffered,
        false,
    );

    // Background and appearance
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setOpaque(false);
    panel.setLevel(NSFloatingWindowLevel + 1);
    panel.setHasShadow(false);

    // Collection behavior — visible on all spaces, stationary
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary,
    );

    // CRITICAL: Make non-activating so it never steals focus
    panel.setFloatingPanel(true);
    panel.setBecomesKeyOnlyIfNeeded(false);
    panel.setWorksWhenModal(true);
    panel.setHidesOnDeactivate(false);

    // Enable mouse events
    panel.setIgnoresMouseEvents(false);
    panel.setAcceptsMouseMovedEvents(true);

    debug_log!(
        "create_panel: frame=({:.0},{:.0},{:.0},{:.0}), level={}, ignoresMouse=false",
        frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
        NSFloatingWindowLevel + 1
    );

    panel
}
