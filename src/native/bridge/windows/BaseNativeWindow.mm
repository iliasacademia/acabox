#import "BaseNativeWindow.h"
#import "../helpers/PanelStyleHelper.h"

@implementation BaseNativeWindow

- (instancetype)initWithSize:(CGSize)size
                windowLevel:(NSWindowLevel)level
                   observer:(WordAccessibilityObserver*)observer {
    self = [super initWithContentRect:NSMakeRect(0, 0, size.width, size.height)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];
    if (self) {
        self.observer = observer;

        // Configure panel style using helper
        [PanelStyleHelper configureAsNonActivatingPopup:self
                                           windowLevel:level
                                             hasShadow:YES  // Native windows usually have shadows
                                            isOpaque:NO];

        // Make panel float above other windows (for buttons and overlays)
        self.floatingPanel = YES;

        // Enable mouse events for native controls
        self.ignoresMouseEvents = NO;
        self.acceptsMouseMovedEvents = YES;

        // Setup mouse tracking (subclass can override)
        [self setupMouseTracking];
    }
    return self;
}

#pragma mark - Mouse Tracking

- (void)setupMouseTracking {
    // Create tracking area for mouse enter/exit events
    self.trackingArea = [[NSTrackingArea alloc] initWithRect:self.contentView.bounds
                                                     options:(NSTrackingMouseEnteredAndExited |
                                                              NSTrackingActiveAlways |
                                                              NSTrackingInVisibleRect)
                                                       owner:self
                                                    userInfo:nil];
    [self.contentView addTrackingArea:self.trackingArea];
}

// Note: updateTrackingAreas is typically called automatically by Cocoa
// when the view hierarchy changes. For manual updates, subclasses should call
// setupMouseTracking directly rather than relying on this method.

#pragma mark - Focus Management

- (BOOL)canBecomeKeyWindow {
    // CRITICAL: Return NO to prevent stealing focus from MS Word
    return NO;
}

- (BOOL)canBecomeMainWindow {
    // CRITICAL: Return NO to prevent becoming the main window
    return NO;
}

#pragma mark - Cleanup

- (void)dealloc {
    if (_trackingArea) {
        [self.contentView removeTrackingArea:_trackingArea];
        _trackingArea = nil;
    }
}

@end
