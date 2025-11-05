#import "OverallReviewButton.h"
#import "../../bridge.h"
#import "../views/DraggableAcceptingWebView.h"
#import <QuartzCore/QuartzCore.h>

@implementation OverallReviewButton

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Create webview-based button - ~200x36 for pill shape (will auto-size to content)
    CGFloat width = 270.0;
    CGFloat height = 40.0;

    // Call base class initializer
    self = [super initWithSize:CGSizeMake(width, height)
                   windowLevel:NSFloatingWindowLevel
                      observer:observer];
    if (self) {
        // Initialize date to current date
        NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
        [formatter setDateFormat:@"EEE, d MMM"];
        self.currentDate = [formatter stringFromDate:[NSDate date]];

        // Make background transparent
        self.backgroundColor = [NSColor clearColor];
        self.opaque = NO;

        // CRITICAL: Make panel non-activating so clicking doesn't steal focus
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;
        self.worksWhenModal = YES;
        self.hidesOnDeactivate = NO;

        // Standard collection behavior
        self.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary |
                                   NSWindowCollectionBehaviorIgnoresCycle;

        // Disable dragging by setting drag handle height to 0
        if ([self.webView isKindOfClass:[DraggableAcceptingWebView class]]) {
            DraggableAcceptingWebView* draggableWebView = (DraggableAcceptingWebView*)self.webView;
            draggableWebView.dragHandleHeight = 0.0;
            NSLog(@"[OverallReviewButton] Disabled dragging by setting dragHandleHeight to 0");
        }

        NSLog(@"[OverallReviewButton] Initialized with date: %@", self.currentDate);
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (void)loadPopupHTML {
    // Set HTML subpath BEFORE loading (called by base class init)
    self.htmlSubpath = @"overallReviewButton";
    NSLog(@"[OverallReviewButton] Loading with subpath: %@", self.htmlSubpath);

    // Call parent implementation which will use the subpath
    [super loadPopupHTML];

    // Send initial date to webview after loading
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self updateDate:self.currentDate];
    });
}

- (NSString*)windowNameForLogging {
    return @"OverallReviewButton";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console logs from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[OverallReviewButton WebView %@] %@", level, msg);
}

- (void)handleBridgeMessage:(NSDictionary*)message {
    NSString* action = message[@"action"];

    // Handle button click
    if ([action isEqualToString:@"buttonClicked"]) {
        NSLog(@"[OverallReviewButton] Button clicked via bridge");
        [self showClickPopup];

        // Send success response
        NSString* messageId = message[@"id"];
        if (messageId) {
            [self sendBridgeResponse:messageId success:YES payload:@{}];
        }
        return;
    }

    NSLog(@"[OverallReviewButton] Unknown action: %@", action);
}

- (void)sendBridgeResponse:(NSString*)messageId success:(BOOL)success payload:(NSDictionary*)payload {
    NSDictionary* response = @{
        @"id": messageId,
        @"from": @"native",
        @"to": @"popup",
        @"type": @"response",
        @"success": @(success),
        @"payload": payload ?: @{},
        @"timestamp": @([[NSDate date] timeIntervalSince1970] * 1000)
    };

    NSError* error;
    NSData* jsonData = [NSJSONSerialization dataWithJSONObject:response options:0 error:&error];
    if (error) {
        NSLog(@"[OverallReviewButton] ERROR serializing response: %@", error);
        return;
    }

    NSString* jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    NSString* jsCode = [NSString stringWithFormat:@"window.__bridgeReceive(%@)", jsonString];

    [self.webView evaluateJavaScript:jsCode completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[OverallReviewButton] ERROR sending response: %@", error);
        }
    }];
}

- (void)sendBridgeEvent:(NSString*)action payload:(NSDictionary*)payload {
    NSDictionary* event = @{
        @"id": [[NSUUID UUID] UUIDString],
        @"from": @"native",
        @"to": @"popup",
        @"type": @"event",
        @"action": action,
        @"payload": payload ?: @{},
        @"timestamp": @([[NSDate date] timeIntervalSince1970] * 1000)
    };

    NSError* error;
    NSData* jsonData = [NSJSONSerialization dataWithJSONObject:event options:0 error:&error];
    if (error) {
        NSLog(@"[OverallReviewButton] ERROR serializing event: %@", error);
        return;
    }

    NSString* jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    NSString* jsCode = [NSString stringWithFormat:@"window.__bridgeReceive(%@)", jsonString];

    [self.webView evaluateJavaScript:jsCode completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[OverallReviewButton] ERROR sending event: %@", error);
        }
    }];
}

#pragma mark - Content Updates

- (void)updateDate:(NSString*)date {
    self.currentDate = date;
    NSLog(@"[OverallReviewButton] Updating date to: %@", date);

    // Send update to webview
    [self sendBridgeEvent:@"updateDate" payload:@{@"date": date}];
}

#pragma mark - Popup Management

- (void)showClickPopup {
    BOOL isNewPopup = NO;
    if (!self.clickPopup) {
        // Create React-based popup window with observer
        self.clickPopup = [[OverallReviewPopup alloc] initWithCount:0 observer:self.observer];

        if (!self.clickPopup) {
            NSLog(@"[OverallReviewButton] ERROR: Failed to create OverallReviewPopup!");
            return;
        }
        isNewPopup = YES;
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
        CGFloat popupHeight = 450;  // Default popup height
        CGFloat verticalSpacing = 4;  // Space between button and popup

        // Position directly below button, left-aligned
        CGFloat popupX = buttonFrame.origin.x;
        CGFloat popupY = buttonFrame.origin.y - popupHeight - verticalSpacing;

        [self.clickPopup setFrameOrigin:NSMakePoint(popupX, popupY)];
        // Save this initial position
        self.clickPopup.savedFrame = self.clickPopup.frame;
    }

    // Set visibility flag before showing (popup is being explicitly opened)
    self.clickPopup.wasVisibleBeforeHiding = YES;
    NSLog(@"[OverallReviewButton] Setting wasVisibleBeforeHiding to YES before showing popup");

    [self.clickPopup orderFront:nil];

    NSLog(@"[OverallReviewButton] Click popup shown at level: %ld", (long)self.clickPopup.level);
}

- (void)hideClickPopup {
    if (self.clickPopup) {
        [self.clickPopup orderOut:nil];
    }
}

#pragma mark - Window Lifecycle

- (void)orderOut:(id)sender {
    // DON'T hide click popup when button is hidden - let it persist
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
    [self hideClickPopup];
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
}

#pragma mark - OverlayWindow Protocol

- (void)updatePositionWithWordState:(WordPositionState)state {
    // Position button at the layout container's top-left corner
    // state.layoutPosition contains the position of the layout container corner

    NSLog(@"[OverallReviewButton] updatePositionWithWordState called with:");
    NSLog(@"  layoutPosition: (%.1f, %.1f)", state.layoutPosition.x, state.layoutPosition.y);
    NSLog(@"  scrollAreaBounds: origin=(%.1f, %.1f) size=(%.1f, %.1f)",
          state.scrollAreaBounds.origin.x, state.scrollAreaBounds.origin.y,
          state.scrollAreaBounds.size.width, state.scrollAreaBounds.size.height);

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

    NSLog(@"[OverallReviewButton] Scroll area bounds check:");
    NSLog(@"  X range: %.1f to %.1f (layout X: %.1f)", scrollMinX, scrollMaxX, state.layoutPosition.x);
    NSLog(@"  Y range: %.1f to %.1f (layout Y: %.1f)", scrollMinY, scrollMaxY, state.layoutPosition.y);

    BOOL xOutOfBounds = state.layoutPosition.x < scrollMinX || state.layoutPosition.x > scrollMaxX;
    BOOL yOutOfBounds = state.layoutPosition.y < scrollMinY || state.layoutPosition.y > scrollMaxY;

    NSLog(@"[OverallReviewButton] Out of bounds check: X=%d, Y=%d", xOutOfBounds, yOutOfBounds);

    if (xOutOfBounds || yOutOfBounds) {
        NSLog(@"[OverallReviewButton] Layout position (%.1f, %.1f) is outside scroll area, hiding button",
              state.layoutPosition.x, state.layoutPosition.y);
        [self hide];
        return;
    }

    // Button is now wider (pill shape), position it to the right and above the layout corner
    CGFloat buttonWidth = self.frame.size.width;
    CGFloat buttonHeight = self.frame.size.height;
    CGFloat rightMargin = 8.0;  // Space to the right of layout corner
    CGFloat topMargin = 8.0;    // Space above layout corner

    // Get primary screen for coordinate conversion
    NSScreen* primaryScreen = [NSScreen screens][0];
    CGFloat primaryScreenHeight = primaryScreen.frame.size.height;
    NSLog(@"[OverallReviewButton] Primary screen height: %.1f", primaryScreenHeight);

    // layoutPosition is in Accessibility coordinates (top-left origin)
    // Convert to Cocoa coordinates (bottom-left origin)
    CGFloat cocoaY = primaryScreenHeight - state.layoutPosition.y;
    NSLog(@"[OverallReviewButton] Coordinate conversion: accessibility Y=%.1f -> cocoa Y=%.1f",
          state.layoutPosition.y, cocoaY);

    // Position button to the right of layout corner, slightly above it
    CGFloat buttonX = state.layoutPosition.x + rightMargin;
    CGFloat buttonY = cocoaY - buttonHeight - topMargin;
    NSLog(@"[OverallReviewButton] Calculated button position: X=%.1f (layout X %.1f + margin %.1f), Y=%.1f (cocoa Y %.1f - height %.1f - margin %.1f)",
          buttonX, state.layoutPosition.x, rightMargin,
          buttonY, cocoaY, buttonHeight, topMargin);

    NSRect newFrame = NSMakeRect(buttonX, buttonY, buttonWidth, buttonHeight);
    [self setFrame:newFrame display:YES];

    NSLog(@"[OverallReviewButton] Positioned at (%.1f, %.1f) with size (%.1f, %.1f) based on layout corner at (%.1f, %.1f)",
          buttonX, buttonY, buttonWidth, buttonHeight, state.layoutPosition.x, state.layoutPosition.y);

    // Show the button if it was previously hidden
    [self show];
}

- (void)hide {
    NSLog(@"[OverallReviewButton] hide called");
    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[OverallReviewButton] show called from:");
    NSLog(@"%@", [NSThread callStackSymbols]);
    [self orderFront:nil];
}

- (NSString *)overlayIdentifier {
    return @"OverallReviewButton";
}

@end
