use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSFloatingWindowLevel, NSPanel, NSWindowCollectionBehavior,
    NSWindowStyleMask,
};
use objc2_foundation::NSRect;

/// Create a non-activating NSPanel matching the config from MacOSWebViewBridge.mm.
///
/// Style: borderless + non-activating panel, transparent background, floating level + 1,
/// no shadow, visible on all spaces, never steals focus.
pub fn create_panel(mtm: MainThreadMarker, frame: NSRect) -> Retained<NSPanel> {
    let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;

    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
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

    panel
}
