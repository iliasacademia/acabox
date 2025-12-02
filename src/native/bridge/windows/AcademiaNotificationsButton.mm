#import "AcademiaNotificationsButton.h"
#import "../../bridge.h"
#import "../views/DraggableAcceptingWebView.h"
#import <QuartzCore/QuartzCore.h>

@implementation AcademiaNotificationsButton

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Create webview-based button - small size for circular button with badge
    CGFloat width = 30.0;   // 24px button + 6px badge overhang
    CGFloat height = 30.0;  // 24px button + 6px badge overhang

    // Call base class initializer
    self = [super initWithSize:CGSizeMake(width, height)
                   windowLevel:NSFloatingWindowLevel
                      observer:observer];
    if (self) {
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
            NSLog(@"[AcademiaNotificationsButton] Disabled dragging by setting dragHandleHeight to 0");
        }

        NSLog(@"[AcademiaNotificationsButton] Initialized with size: %.1fx%.1f", width, height);
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (void)loadPopupHTML {
    // Set HTML subpath BEFORE loading (called by base class init)
    self.htmlSubpath = @"academiaNotificationsButton";
    NSLog(@"[AcademiaNotificationsButton] Loading with subpath: %@", self.htmlSubpath);

    // Call parent implementation which will use the subpath
    [super loadPopupHTML];
}

- (NSString*)windowNameForLogging {
    return @"AcademiaNotificationsButton";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console logs from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[AcademiaNotificationsButton WebView %@] %@", level, msg);
}

- (void)handleBridgeMessage:(NSDictionary*)message {
    NSString* action = message[@"action"];

    // Handle button click
    if ([action isEqualToString:@"buttonClicked"]) {
        NSLog(@"[AcademiaNotificationsButton] Button clicked via bridge");
        [self showPopup];

        // Send success response
        NSString* messageId = message[@"id"];
        if (messageId) {
            [self sendBridgeResponse:messageId success:YES payload:@{}];
        }
        return;
    }

    NSLog(@"[AcademiaNotificationsButton] Unknown action: %@", action);
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
        NSLog(@"[AcademiaNotificationsButton] ERROR serializing response: %@", error);
        return;
    }

    NSString* jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    NSString* jsCode = [NSString stringWithFormat:@"window.__bridgeReceive(%@)", jsonString];

    [self.webView evaluateJavaScript:jsCode completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[AcademiaNotificationsButton] ERROR sending response: %@", error);
        }
    }];
}

#pragma mark - Popup Management

- (void)showPopup {
    // Toggle popup visibility if it already exists and is visible
    if (self.popup && [self.popup isVisible]) {
        NSLog(@"[AcademiaNotificationsButton] Popup is visible, hiding it (toggle off)");
        [self hidePopup];
        self.popupWasVisible = NO;
        return;
    }

    // Create popup if it doesn't exist
    if (!self.popup) {
        self.popup = [[AcademiaNotificationsPopup alloc] initWithObserver:self.observer];

        if (!self.popup) {
            NSLog(@"[AcademiaNotificationsButton] ERROR: Failed to create AcademiaNotificationsPopup!");
            return;
        }
        NSLog(@"[AcademiaNotificationsButton] Created new popup window");
    }

    // Position popup above the button (preserve popup's own size)
    NSRect buttonFrame = self.frame;
    CGFloat margin = 8.0;  // Space between button and popup

    // In Cocoa coordinates (bottom-left origin):
    // - buttonFrame.origin.y is the bottom of the button
    // - buttonFrame.origin.y + buttonFrame.size.height is the top of the button
    // - To place popup above, set popup's origin.y to button's top + margin
    CGFloat popupX = buttonFrame.origin.x;  // Align left edges
    CGFloat popupY = buttonFrame.origin.y + buttonFrame.size.height + margin;  // Above button with margin

    // Only update position, keep popup's own configured width/height
    [self.popup setFrameOrigin:NSMakePoint(popupX, popupY)];
    [self.popup orderFront:nil];
    self.popupWasVisible = YES;  // Mark popup as visible for Word state tracking

    NSLog(@"[AcademiaNotificationsButton] Popup shown above button at position (%.1f, %.1f)", popupX, popupY);
}

- (void)hidePopup {
    if (self.popup) {
        [self.popup orderOut:nil];
        NSLog(@"[AcademiaNotificationsButton] Popup hidden");
    }
}

#pragma mark - Window Lifecycle

- (void)orderOut:(id)sender {
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

    NSLog(@"[AcademiaNotificationsButton] Applied clipping mask - local visible rect: (%.1f, %.1f, %.1f, %.1f)",
          localVisible.origin.x, localVisible.origin.y, localVisible.size.width, localVisible.size.height);
}

- (void)clearVisibleRectMask {
    // Remove mask to show full button
    self.contentView.layer.mask = nil;
}

- (void)dealloc {
    // Close and cleanup popup
    if (_popup) {
        [_popup close];
        _popup = nil;
    }
}

#pragma mark - OverlayWindow Protocol

- (void)updatePositionWithWordState:(WordPositionState)state {
    // Position button at bottom-left of Word scroll area

    // If scrollAreaBounds is empty, hide the button
    if (CGRectIsEmpty(state.scrollAreaBounds)) {
        NSLog(@"[AcademiaNotificationsButton] Cannot position - scrollAreaBounds is empty, hiding button");
        [self hide];
        return;
    }

    // Button dimensions (30x30 to accommodate button + badge)
    CGFloat windowWidth = 40.0;
    CGFloat windowHeight = 40.0;

    // Margins from scroll area edges
    CGFloat leftMargin = 50.0;   // Space from left edge of scroll area
    CGFloat bottomMargin = 12.0;  // Space from bottom edge of scroll area

    // Get primary screen for coordinate conversion
    NSScreen* primaryScreen = [NSScreen screens][0];
    CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

    // scrollAreaBounds is in Accessibility coordinates (top-left origin)
    // Need to convert to Cocoa coordinates (bottom-left origin)

    // Calculate bottom-left corner of scroll area in Cocoa coordinates
    // AX: scrollAreaBounds.origin.y is the TOP of the scroll area
    // AX: scrollAreaBounds.origin.y + scrollAreaBounds.size.height is the BOTTOM of the scroll area
    CGFloat scrollAreaBottomAX = state.scrollAreaBounds.origin.y + state.scrollAreaBounds.size.height;
    CGFloat scrollAreaBottomCocoa = primaryScreenHeight - scrollAreaBottomAX;

    // Position button at bottom-left with margins
    // X: Scroll area left + margin
    CGFloat buttonX = state.scrollAreaBounds.origin.x + leftMargin;
    // Y: Scroll area bottom (in Cocoa coords) + margin
    CGFloat buttonY = scrollAreaBottomCocoa + bottomMargin;

    // Set button frame
    NSRect newFrame = NSMakeRect(buttonX, buttonY, windowWidth, windowHeight);
    [self setFrame:newFrame display:YES];

    NSLog(@"[AcademiaNotificationsButton] Positioned at (%.1f, %.1f) based on scroll area at (%.1f, %.1f, %.1f, %.1f)",
          buttonX, buttonY,
          state.scrollAreaBounds.origin.x, state.scrollAreaBounds.origin.y,
          state.scrollAreaBounds.size.width, state.scrollAreaBounds.size.height);

    // Show the button if it was previously hidden
    if (![self isVisible]) {
        [self show];
    }
}

- (void)hide {
    NSLog(@"[AcademiaNotificationsButton] hide called");

    // Track popup visibility state before hiding
    if (self.popup && [self.popup isVisible]) {
        NSLog(@"[AcademiaNotificationsButton] Popup is visible, hiding it and marking for re-show");
        self.popupWasVisible = YES;
        [self.popup orderOut:nil];
    } else {
        self.popupWasVisible = NO;
    }

    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[AcademiaNotificationsButton] show called");
    [self orderFront:nil];

    // Re-show popup if it was visible before Word state changed
    if (self.popupWasVisible && self.popup) {
        NSLog(@"[AcademiaNotificationsButton] Re-showing popup after Word state change");

        // Recalculate popup position based on button's new position (preserve popup's own size)
        NSRect buttonFrame = self.frame;
        CGFloat margin = 8.0;

        CGFloat popupX = buttonFrame.origin.x;
        CGFloat popupY = buttonFrame.origin.y + buttonFrame.size.height + margin;

        // Only update position, keep popup's own configured width/height
        [self.popup setFrameOrigin:NSMakePoint(popupX, popupY)];
        [self.popup orderFront:nil];
    }
}

- (NSString *)overlayIdentifier {
    return @"NotificationsButton";
}

@end
