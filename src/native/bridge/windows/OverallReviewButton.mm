#import "OverallReviewButton.h"
#import "../../bridge.h"
#import <QuartzCore/QuartzCore.h>

@implementation OverallReviewButton

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Create borderless, transparent panel - 24x24 for circular button
    CGFloat buttonSize = 24.0;
    self = [super initWithContentRect:NSMakeRect(0, 0, buttonSize, buttonSize)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];
    if (self) {
        self.observer = observer;
        self.backgroundColor = [NSColor clearColor];
        self.opaque = NO;
        self.level = NSFloatingWindowLevel;  // Always on top
        self.ignoresMouseEvents = NO;
        self.hasShadow = YES;
        self.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary |
                                   NSWindowCollectionBehaviorIgnoresCycle;

        // CRITICAL: Make panel non-activating so hovering doesn't steal focus
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;
        self.worksWhenModal = YES;
        self.hidesOnDeactivate = NO;

        // Generate random count (1-12, showing "9+" for 10+)
        self.count = 1 + (arc4random_uniform(12));

        // Create circular background view
        NSView* circleView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, buttonSize, buttonSize)];
        circleView.wantsLayer = YES;
        circleView.layer.backgroundColor = [[NSColor whiteColor] CGColor];
        circleView.layer.borderColor = [[NSColor blackColor] CGColor];
        circleView.layer.borderWidth = 1.0;  // 1px border
        circleView.layer.cornerRadius = buttonSize / 2;  // Make it circular
        [self.contentView addSubview:circleView];

        // Create label for number with proper vertical centering
        // NSTextField doesn't center vertically by default, so we need to adjust the frame
        CGFloat labelHeight = 14;  // Height for the text (adjusted for 10pt font in 24px button)
        CGFloat labelY = (buttonSize - labelHeight) / 2;  // Center vertically
        self.countLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(0, labelY, buttonSize, labelHeight)];
        self.countLabel.stringValue = self.count > 9 ? @"9+" : [NSString stringWithFormat:@"%d", self.count];
        self.countLabel.font = [NSFont boldSystemFontOfSize:10];
        self.countLabel.textColor = [NSColor blackColor];
        self.countLabel.backgroundColor = [NSColor clearColor];
        self.countLabel.bordered = NO;
        self.countLabel.editable = NO;
        self.countLabel.selectable = NO;
        self.countLabel.alignment = NSTextAlignmentCenter;
        self.countLabel.lineBreakMode = NSLineBreakByClipping;
        [self.contentView addSubview:self.countLabel];

        // Setup mouse tracking for hover
        [self setupMouseTracking];

        NSLog(@"[OverallReviewButton] Initialized with count: %d", self.count);
    }
    return self;
}

- (void)setupMouseTracking {
    NSLog(@"[OverallReviewButton] Setting up mouse tracking");
    NSLog(@"[OverallReviewButton] Content view bounds: x=%.1f y=%.1f w=%.1f h=%.1f",
          self.contentView.bounds.origin.x, self.contentView.bounds.origin.y,
          self.contentView.bounds.size.width, self.contentView.bounds.size.height);

    self.trackingArea = [[NSTrackingArea alloc] initWithRect:self.contentView.bounds
                                                     options:(NSTrackingMouseEnteredAndExited |
                                                              NSTrackingActiveAlways |
                                                              NSTrackingInVisibleRect)
                                                       owner:self
                                                    userInfo:nil];
    [self.contentView addTrackingArea:self.trackingArea];
    NSLog(@"[OverallReviewButton] Mouse tracking setup complete");
    NSLog(@"[OverallReviewButton] ignoresMouseEvents: %d", self.ignoresMouseEvents);
    NSLog(@"[OverallReviewButton] acceptsMouseMovedEvents: %d", self.acceptsMouseMovedEvents);
}

- (void)updateCount:(int)count {
    self.count = count;
    self.countLabel.stringValue = count > 9 ? @"9+" : [NSString stringWithFormat:@"%d", count];
}

- (void)mouseEntered:(NSEvent *)event {
    NSLog(@"[OverallReviewButton] Mouse entered");
    [self cancelScheduledHide];
    [self showHoverPopup];
}

- (void)mouseExited:(NSEvent *)event {
    NSLog(@"[OverallReviewButton] Mouse exited");
    [self scheduleHidePopup];
}

- (void)mouseDown:(NSEvent *)event {
    NSLog(@"[OverallReviewButton] ===== MOUSE DOWN EVENT RECEIVED =====");
    NSLog(@"[OverallReviewButton] Event type: %ld", (long)event.type);
    NSLog(@"[OverallReviewButton] Click count: %ld", (long)event.clickCount);
    NSLog(@"[OverallReviewButton] Button frame: x=%.1f y=%.1f w=%.1f h=%.1f",
          self.frame.origin.x, self.frame.origin.y, self.frame.size.width, self.frame.size.height);

    // Hide hover popup if showing
    NSLog(@"[OverallReviewButton] Hiding hover popup (if visible)...");
    [self hideHoverPopup];

    // Show the larger click popup
    NSLog(@"[OverallReviewButton] Calling showClickPopup...");
    [self showClickPopup];
    NSLog(@"[OverallReviewButton] ===== MOUSE DOWN HANDLING COMPLETE =====");
}

- (void)showHoverPopup {
    [self cancelScheduledHide];

    if (!self.hoverPopup) {
        // Create popup window
        CGFloat popupWidth = 220;
        CGFloat popupHeight = 100;

        self.hoverPopup = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, popupWidth, popupHeight)
                                                     styleMask:NSWindowStyleMaskBorderless
                                                       backing:NSBackingStoreBuffered
                                                         defer:NO];
        self.hoverPopup.backgroundColor = [NSColor whiteColor];
        self.hoverPopup.opaque = YES;
        self.hoverPopup.level = NSFloatingWindowLevel + 1;  // Above the button
        self.hoverPopup.hasShadow = YES;
        self.hoverPopup.floatingPanel = YES;
        self.hoverPopup.becomesKeyOnlyIfNeeded = NO;

        // Add border
        self.hoverPopup.contentView.wantsLayer = YES;
        self.hoverPopup.contentView.layer.borderColor = [[NSColor colorWithWhite:0.8 alpha:1.0] CGColor];
        self.hoverPopup.contentView.layer.borderWidth = 1.0;
        self.hoverPopup.contentView.layer.cornerRadius = 8.0;

        // Add title label
        NSTextField* titleLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(12, popupHeight - 35, popupWidth - 24, 20)];
        titleLabel.stringValue = @"Line Information";
        titleLabel.font = [NSFont boldSystemFontOfSize:13];
        titleLabel.textColor = [NSColor blackColor];
        titleLabel.backgroundColor = [NSColor clearColor];
        titleLabel.bordered = NO;
        titleLabel.editable = NO;
        titleLabel.selectable = NO;
        [self.hoverPopup.contentView addSubview:titleLabel];

        // Add count label
        NSTextField* countInfoLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(12, popupHeight - 60, popupWidth - 24, 20)];
        countInfoLabel.stringValue = [NSString stringWithFormat:@"Count: %d", self.count];
        countInfoLabel.font = [NSFont systemFontOfSize:12];
        countInfoLabel.textColor = [NSColor colorWithWhite:0.4 alpha:1.0];
        countInfoLabel.backgroundColor = [NSColor clearColor];
        countInfoLabel.bordered = NO;
        countInfoLabel.editable = NO;
        countInfoLabel.selectable = NO;
        [self.hoverPopup.contentView addSubview:countInfoLabel];

        // Add info label
        NSTextField* infoLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(12, popupHeight - 85, popupWidth - 24, 20)];
        infoLabel.stringValue = @"Click to view details";
        infoLabel.font = [NSFont systemFontOfSize:12];
        infoLabel.textColor = [NSColor colorWithWhite:0.4 alpha:1.0];
        infoLabel.backgroundColor = [NSColor clearColor];
        infoLabel.bordered = NO;
        infoLabel.editable = NO;
        infoLabel.selectable = NO;
        [self.hoverPopup.contentView addSubview:infoLabel];

        // Setup mouse tracking for popup
        self.popupTrackingArea = [[NSTrackingArea alloc]
            initWithRect:self.hoverPopup.contentView.bounds
                 options:(NSTrackingMouseEnteredAndExited |
                          NSTrackingActiveAlways |
                          NSTrackingInVisibleRect)
                   owner:self
                userInfo:nil];
        [self.hoverPopup.contentView addTrackingArea:self.popupTrackingArea];
    }

    // Position popup to the right of button
    NSRect buttonFrame = self.frame;
    CGFloat popupX = buttonFrame.origin.x + buttonFrame.size.width + 8;
    CGFloat popupY = buttonFrame.origin.y;

    [self.hoverPopup setFrameOrigin:NSMakePoint(popupX, popupY)];
    [self.hoverPopup orderFrontRegardless];
    NSLog(@"[OverallReviewButton] Popup shown");
}

- (void)hideHoverPopup {
    [self cancelScheduledHide];
    if (self.hoverPopup) {
        [self.hoverPopup orderOut:nil];
    }
}

- (void)showClickPopup {
    BOOL isNewPopup = NO;
    if (!self.clickPopup) {
        // Create React-based popup window with current count and observer
        self.clickPopup = [[OverallReviewPopup alloc] initWithCount:self.count observer:self.observer];

        if (!self.clickPopup) {
            NSLog(@"[OverallReviewButton] ERROR: Failed to create ClickPopupWindow!");
            return;
        }
        isNewPopup = YES;
    } else {
        // Update content with current count
        [self.clickPopup updateContentWithCount:self.count];
    }

    // Register window observers for new popup
    if (isNewPopup && self.observer) {
        [self.observer registerClickPopupObservers];

        // Register popup with AcademiaManager to receive activation/deactivation events
        if ([self.observer respondsToSelector:@selector(getAcademiaManager)]) {
            id academiaManager = [self.observer getAcademiaManager];
            if (academiaManager && [academiaManager respondsToSelector:@selector(registerOverlay:)]) {
                [academiaManager registerOverlay:self.clickPopup];
                NSLog(@"[OverallReviewButton] Registered popup with AcademiaManager");
            } else {
                NSLog(@"[OverallReviewButton] WARNING: Could not register popup - AcademiaManager not available");
            }
        }
    }

    // Position popup: use saved position if available, otherwise calculate default
    if (!NSEqualRects(self.clickPopup.savedFrame, NSZeroRect)) {
        // Restore saved position and size from last time
        [self.clickPopup setFrame:self.clickPopup.savedFrame display:YES];
    } else {
        // First time showing - calculate default position relative to button
        NSRect buttonFrame = self.frame;
        CGFloat popupX = buttonFrame.origin.x + buttonFrame.size.width + 8;  // 8px to the right of button
        CGFloat popupY = buttonFrame.origin.y - 404;  // Top of popup 4px below button bottom (4 + 400 = 404)

        [self.clickPopup setFrameOrigin:NSMakePoint(popupX, popupY)];
        // Save this initial position
        self.clickPopup.savedFrame = self.clickPopup.frame;
    }

    // Set visibility flag before showing (popup is being explicitly opened)
    self.clickPopup.wasVisibleBeforeHiding = YES;
    NSLog(@"[OverallReviewButton] Setting wasVisibleBeforeHiding to YES before showing popup");

    [self.clickPopup orderFront:nil];

    // Debug logging: Compare window levels
    NSLog(@"[OverallReviewButton] ===== WINDOW LEVEL DEBUG =====");
    NSLog(@"[OverallReviewButton] ClickPopupWindow level: %ld", (long)self.clickPopup.level);

    // Get active app
    NSRunningApplication* activeApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    NSLog(@"[OverallReviewButton] Active app: %@ (PID: %d)", activeApp.localizedName, activeApp.processIdentifier);

    // Get window levels from CGWindowList
    CFArrayRef windowList = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    if (windowList) {
        for (NSDictionary* windowInfo in (__bridge NSArray*)windowList) {
            NSString* ownerName = windowInfo[(id)kCGWindowOwnerName];
            NSNumber* windowLevel = windowInfo[(id)kCGWindowLayer];
            NSNumber* windowPID = windowInfo[(id)kCGWindowOwnerPID];

            // Log Word windows
            if ([ownerName isEqualToString:@"Microsoft Word"]) {
                NSLog(@"[OverallReviewButton] Word window level: %@", windowLevel);
            }

            // Log active app windows
            if ([windowPID intValue] == activeApp.processIdentifier) {
                NSLog(@"[OverallReviewButton] %@ window level: %@", ownerName, windowLevel);
            }
        }
        CFRelease(windowList);
    }
    NSLog(@"[OverallReviewButton] =====================================");
}

- (void)hideClickPopup {
    if (self.clickPopup) {
        [self.clickPopup orderOut:nil];
    }
}

- (void)scheduleHidePopup {
    // WAGENT-79: Remove 300ms arbitrary delay
    // The NSTrackingArea (line 73) already handles mouseExited properly,
    // so we can hide immediately when the mouse actually leaves
    [self cancelScheduledHide];
    [self hideHoverPopup];
}

- (void)cancelScheduledHide {
    if (self.scheduledHideBlock) {
        dispatch_block_cancel(self.scheduledHideBlock);
        self.scheduledHideBlock = nil;
    }
}

- (void)orderOut:(id)sender {
    [self hideHoverPopup];
    // DON'T hide click popup when button is hidden - let it persist
    // [self hideClickPopup];  // COMMENTED OUT
    [super orderOut:sender];
}

- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame {
    // Convert global visibleRect to button's local coordinates
    CGRect localVisible = CGRectMake(
        visibleRect.origin.x - fullFrame.origin.x,
        visibleRect.origin.y - fullFrame.origin.y,
        visibleRect.size.width,
        visibleRect.size.height
    );

    // Create mask layer with visible rect
    CAShapeLayer *maskLayer = [CAShapeLayer layer];
    CGPathRef path = CGPathCreateWithRect(localVisible, NULL);
    maskLayer.path = path;
    CGPathRelease(path);

    // Apply mask to content view
    self.contentView.layer.mask = maskLayer;

    NSLog(@"[OverallReviewButton] Applied clipping mask - local visible rect: (%.1f, %.1f, %.1f, %.1f)",
          localVisible.origin.x, localVisible.origin.y, localVisible.size.width, localVisible.size.height);
}

- (void)clearVisibleRectMask {
    // Remove mask to show full button
    self.contentView.layer.mask = nil;
}

- (void)dealloc {
    [self hideHoverPopup];
    [self hideClickPopup];
    if (_popupTrackingArea && _hoverPopup) {
        [_hoverPopup.contentView removeTrackingArea:_popupTrackingArea];
        _popupTrackingArea = nil;
    }
    if (_hoverPopup) {
        [_hoverPopup close];
        _hoverPopup = nil;
    }
    if (_clickPopup) {
        // Unregister observers before closing
        if (self.observer) {
            [self.observer unregisterClickPopupObservers];

            // Unregister popup from AcademiaManager
            if ([self.observer respondsToSelector:@selector(getAcademiaManager)]) {
                id academiaManager = [self.observer getAcademiaManager];
                if (academiaManager && [academiaManager respondsToSelector:@selector(unregisterOverlay:)]) {
                    [academiaManager unregisterOverlay:_clickPopup];
                    NSLog(@"[OverallReviewButton] Unregistered popup from AcademiaManager");
                }
            }
        }
        [_clickPopup close];
        _clickPopup = nil;
    }
    if (_trackingArea) {
        [self.contentView removeTrackingArea:_trackingArea];
        _trackingArea = nil;
    }
}

- (BOOL)canBecomeKeyWindow {
    return NO;
}

- (BOOL)canBecomeMainWindow {
    return NO;
}

#pragma mark - OverlayWindow Protocol

- (void)updatePositionWithWordState:(WordPositionState)state {
    // Position button at the layout container's top-left corner
    // state.layoutPosition contains the position of the layout container corner

    if (CGPointEqualToPoint(state.layoutPosition, CGPointZero)) {
        NSLog(@"[OverallReviewButton] Cannot position - layoutPosition is invalid");
        return;
    }

    // Check if scrollAreaBounds is valid
    if (CGRectIsEmpty(state.scrollAreaBounds)) {
        NSLog(@"[OverallReviewButton] Cannot position - scrollAreaBounds is empty, hiding button");
        [self hide];
        return;
    }

    // Check if layout position is outside the scroll area (in Accessibility coordinates)
    CGFloat scrollMinX = state.scrollAreaBounds.origin.x;
    CGFloat scrollMaxX = state.scrollAreaBounds.origin.x + state.scrollAreaBounds.size.width;
    CGFloat scrollMinY = state.scrollAreaBounds.origin.y;
    CGFloat scrollMaxY = state.scrollAreaBounds.origin.y + state.scrollAreaBounds.size.height;

    if (state.layoutPosition.x < scrollMinX || state.layoutPosition.x > scrollMaxX ||
        state.layoutPosition.y < scrollMinY || state.layoutPosition.y > scrollMaxY) {
        NSLog(@"[OverallReviewButton] Layout position (%.1f, %.1f) is outside scroll area (%.1f, %.1f, %.1f, %.1f), hiding button",
              state.layoutPosition.x, state.layoutPosition.y,
              scrollMinX, scrollMinY, scrollMaxX, scrollMaxY);
        [self hide];
        return;
    }

    // Button is 24x24, position it to the right and above the layout corner
    CGFloat buttonSize = 24.0;
    CGFloat rightMargin = 8.0;  // Space to the right of layout corner
    CGFloat topMargin = 8.0;    // Space above layout corner

    // Get primary screen for coordinate conversion
    NSScreen* primaryScreen = [NSScreen screens][0];
    CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

    // layoutPosition is in Accessibility coordinates (top-left origin)
    // Convert to Cocoa coordinates (bottom-left origin)
    CGFloat cocoaY = primaryScreenHeight - state.layoutPosition.y;

    // Position button to the right of layout corner, slightly above it
    CGFloat buttonX = state.layoutPosition.x + rightMargin;
    CGFloat buttonY = cocoaY - buttonSize - topMargin;

    NSRect newFrame = NSMakeRect(buttonX, buttonY, buttonSize, buttonSize);
    [self setFrame:newFrame display:YES];

    NSLog(@"[OverallReviewButton] Positioned at (%.1f, %.1f) based on layout corner at (%.1f, %.1f)",
          buttonX, buttonY, state.layoutPosition.x, state.layoutPosition.y);

    // Show the button if it was previously hidden
    [self show];
}

- (void)hide {
    NSLog(@"[OverallReviewButton] hide called");
    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[OverallReviewButton] show called");
    [self orderFront:nil];
}

// isVisible is inherited from NSWindow - no need to override

- (NSString *)overlayIdentifier {
    return @"OverallReviewButton";
}

@end
