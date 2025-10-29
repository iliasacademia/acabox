#import "ButtonOverlayWindow.h"
#import <QuartzCore/QuartzCore.h>

@implementation ButtonOverlayWindow

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Create borderless, transparent panel - fixed size for circular button (24px)
    // Use NSPanel with non-activating style to prevent stealing focus from Word
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

        // CRITICAL: Make panel non-activating so clicking button doesn't steal focus
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;  // Never become key window
        self.worksWhenModal = YES;  // Continue working even when modal dialogs are present
        self.hidesOnDeactivate = NO;  // Don't auto-hide when app deactivates

        // Create circular button with white "A" letter
        self.button = [[NSButton alloc] initWithFrame:NSMakeRect(0, 0, buttonSize, buttonSize)];
        self.button.title = @"A";
        self.button.font = [NSFont boldSystemFontOfSize:14];
        self.button.bezelStyle = NSBezelStyleInline;
        self.button.bordered = NO;

        // Set up button action
        self.button.target = self;
        self.button.action = @selector(buttonClicked:);

        // Style the button as black circle with white text
        self.button.wantsLayer = YES;
        self.button.layer.backgroundColor = [[NSColor colorWithRed:0.0 green:0.0 blue:0.0 alpha:0.9] CGColor];
        self.button.layer.cornerRadius = buttonSize / 2;  // Make it circular

        // Set text color to white
        NSMutableAttributedString *title = [[NSMutableAttributedString alloc] initWithString:@"A"];
        [title addAttribute:NSForegroundColorAttributeName
                     value:[NSColor whiteColor]
                     range:NSMakeRange(0, title.length)];
        [title addAttribute:NSFontAttributeName
                     value:[NSFont boldSystemFontOfSize:14]
                     range:NSMakeRange(0, title.length)];
        self.button.attributedTitle = title;

        [self.contentView addSubview:self.button];

        // Add mouse tracking for hover (disabled for now - just console logging)
        // [self setupMouseTracking];
    }
    return self;
}

- (void)setupMouseTracking {
    self.trackingArea = [[NSTrackingArea alloc] initWithRect:self.button.bounds
                                                     options:(NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways)
                                                       owner:self
                                                    userInfo:nil];
    [self.button addTrackingArea:self.trackingArea];
}

- (void)mouseEntered:(NSEvent *)event {
    [self cancelScheduledHide];
    [self showPopup];
}

- (void)mouseExited:(NSEvent *)event {
    [self scheduleHidePopup];
}

- (void)showPopup {
    // Cancel any scheduled hide
    [self cancelScheduledHide];

    if (self.selectedText && self.selectedText.length > 0) {
        // Reuse existing popup window if available (keeps React loaded and ready)
        if (!self.popupWindow) {
            NSLog(@"[ButtonOverlayWindow] Creating new popup window");
            self.popupWindow = [[TextPopupWindow alloc] initWithText:self.selectedText];
            // Connect popup back to button for mouse coordination
            self.popupWindow.buttonWindow = self;
        } else {
            // Update existing popup with new text (instant update, no reload delay)
            NSLog(@"[ButtonOverlayWindow] Reusing existing popup window");
            [self.popupWindow updateContentWithText:self.selectedText];
        }

        // Get selection bounds (in top-left coordinate system from Accessibility API)
        CGRect selection = self.selectionBounds;
        NSRect popupFrame = self.popupWindow.frame;

        // Get the primary screen height to convert coordinates
        NSScreen* primaryScreen = [NSScreen screens][0];
        CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

        // Convert selection to Cocoa coordinates (bottom-left origin)
        CGFloat selectionTop = primaryScreenHeight - selection.origin.y;  // Top in Cocoa coords
        CGFloat selectionBottom = primaryScreenHeight - (selection.origin.y + selection.size.height);  // Bottom in Cocoa coords

        // Find which screen contains the selection
        NSScreen* targetScreen = nil;
        for (NSScreen* screen in [NSScreen screens]) {
            NSRect screenFrame = screen.frame;
            CGFloat selectionCenterY = (selectionTop + selectionBottom) / 2;
            if (selection.origin.x >= screenFrame.origin.x &&
                selection.origin.x <= screenFrame.origin.x + screenFrame.size.width &&
                selectionCenterY >= screenFrame.origin.y &&
                selectionCenterY <= screenFrame.origin.y + screenFrame.size.height) {
                targetScreen = screen;
                break;
            }
        }

        if (!targetScreen) {
            targetScreen = [NSScreen mainScreen];
        }

        NSRect screenFrame = targetScreen.frame;

        // Calculate available space above and below selection
        // In Cocoa coords: higher Y = higher on screen (towards top)
        // Space visually ABOVE = from selection top to screen top
        CGFloat spaceAbove = (screenFrame.origin.y + screenFrame.size.height) - selectionTop;
        // Space visually BELOW = from selection bottom to screen bottom
        CGFloat spaceBelow = selectionBottom - screenFrame.origin.y;

        CGFloat popupX, popupY;

        // Position horizontally: align with left edge of selection
        popupX = selection.origin.x;

        // Ensure popup fits within screen horizontally
        if (popupX + popupFrame.size.width > screenFrame.origin.x + screenFrame.size.width) {
            popupX = screenFrame.origin.x + screenFrame.size.width - popupFrame.size.width - 10;
        }

        // Position vertically: above or below based on available space
        // Note: In Cocoa coords, window origin (popupY) is at bottom-left of window
        if (spaceAbove >= popupFrame.size.height || spaceAbove > spaceBelow) {
            // Position visually ABOVE selection (higher Y value)
            // Popup bottom should be at selection top, with slight overlap
            popupY = selectionTop - 3;
        } else {
            // Position visually BELOW selection (lower Y value)
            // Popup top should be at selection bottom, with slight overlap
            popupY = selectionBottom - popupFrame.size.height + 3;
        }

        [self.popupWindow setFrameOrigin:NSMakePoint(popupX, popupY)];
        // Use orderFront without activating the application
        [self.popupWindow orderFrontRegardless];
    }
}

- (void)hidePopup {
    // Cancel any scheduled hide
    [self cancelScheduledHide];

    if (self.popupWindow) {
        // Just hide the window, don't destroy it (keeps React loaded for instant reappearance)
        NSLog(@"[ButtonOverlayWindow] Hiding popup (keeping window alive for reuse)");
        [self.popupWindow orderOut:nil];
        // Don't close or nil out the window - we'll reuse it next time
    }
}

- (void)scheduleHidePopup {
    // Cancel any existing scheduled hide
    [self cancelScheduledHide];

    // Schedule hide after a delay (400ms gives enough time to move mouse to popup)
    __weak __typeof__(self) weakSelf = self;
    self.scheduledHideBlock = dispatch_block_create(DISPATCH_BLOCK_INHERIT_QOS_CLASS, ^{
        __typeof__(self) strongSelf = weakSelf;
        if (strongSelf) {
            [strongSelf hidePopup];
            strongSelf.scheduledHideBlock = nil;
        }
    });

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.4 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(),
                   self.scheduledHideBlock);
}

- (void)cancelScheduledHide {
    if (self.scheduledHideBlock) {
        dispatch_block_cancel(self.scheduledHideBlock);
        self.scheduledHideBlock = nil;
    }
}

- (void)setSelectedText:(NSString*)text {
    _selectedText = text;
}

- (void)buttonClicked:(id)sender {
    // When button is clicked, notify the observer
    if (self.observer) {
        // Use performSelector to avoid forward declaration issues
        id observer = self.observer;
        #pragma clang diagnostic push
        #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        [observer performSelector:@selector(handleButtonClick)];
        #pragma clang diagnostic pop
    }
}

- (void)positionAtPoint:(CGPoint)point withHeight:(CGFloat)selectionHeight {
    // Find which screen contains this point
    // The Accessibility API returns coordinates in a global coordinate system
    // We need to find which screen contains these coordinates

    NSScreen* targetScreen = nil;

    // Get the primary screen height to convert from top-left to bottom-left coordinates
    NSScreen* primaryScreen = [NSScreen screens][0];  // Screen with origin (0,0)
    CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

    // Convert accessibility point (top-left origin) to Cocoa coordinates (bottom-left origin)
    CGFloat cocoaY = primaryScreenHeight - point.y;

    // Find the screen that contains this point
    for (NSScreen* screen in [NSScreen screens]) {
        NSRect screenFrame = screen.frame;

        // Check if point is within this screen's bounds (in Cocoa coordinates)
        if (point.x >= screenFrame.origin.x &&
            point.x <= screenFrame.origin.x + screenFrame.size.width &&
            cocoaY >= screenFrame.origin.y &&
            cocoaY <= screenFrame.origin.y + screenFrame.size.height) {
            targetScreen = screen;
            break;
        }
    }

    // Fall back to main screen if no screen found
    if (!targetScreen) {
        targetScreen = [NSScreen mainScreen];
    }

    // Calculate window Y position
    // point.y is the TOP of the selection (in top-left coordinate system)
    // We need to position the window so it spans from top to bottom of selection
    // In Cocoa coordinates (bottom-left origin), the window origin is at the bottom-left
    // So: windowY = cocoaY - selectionHeight
    CGFloat windowY = cocoaY - selectionHeight;

    // Resize window and button to match selection height
    NSRect newFrame = NSMakeRect(point.x, windowY, 10, selectionHeight);
    [self setFrame:newFrame display:YES];

    // Update button frame to fill the window
    self.button.frame = NSMakeRect(0, 0, 10, selectionHeight);

    // Update tracking area for new button size
    if (self.trackingArea) {
        [self.button removeTrackingArea:self.trackingArea];
    }
    [self setupMouseTracking];
}

- (void)orderOut:(id)sender {
    [self hidePopup];
    [super orderOut:sender];
}

- (void)destroyPopup {
    // Actually destroy the popup window (for cleanup)
    if (self.popupWindow) {
        NSLog(@"[ButtonOverlayWindow] Destroying popup window");
        [self.popupWindow orderOut:nil];
        [self.popupWindow close];
        self.popupWindow = nil;
    }
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

    NSLog(@"[ButtonOverlayWindow] Applied clipping mask - local visible rect: (%.1f, %.1f, %.1f, %.1f)",
          localVisible.origin.x, localVisible.origin.y, localVisible.size.width, localVisible.size.height);
}

- (void)clearVisibleRectMask {
    // Remove mask to show full button
    self.contentView.layer.mask = nil;
    NSLog(@"[ButtonOverlayWindow] Cleared clipping mask");
}

- (void)dealloc {
    // Clean up popup window completely during dealloc
    [self destroyPopup];

    // Remove tracking area
    if (_trackingArea) {
        [_button removeTrackingArea:_trackingArea];
        _trackingArea = nil;
    }
}

@end
