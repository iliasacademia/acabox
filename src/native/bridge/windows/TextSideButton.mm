#import "TextSideButton.h"
#import "../../bridge.h"
#import "../views/DraggableAcceptingWebView.h"

@implementation TextSideButton

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer searchText:(NSString*)text {
    CGFloat width = 24.0;
    CGFloat height = 24.0;

    // Call base class initializer
    self = [super initWithSize:CGSizeMake(width, height)
                   windowLevel:NSFloatingWindowLevel
                      observer:observer];
    if (self) {
        self.searchText = text;

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
            NSLog(@"[TextSideButton] Disabled dragging by setting dragHandleHeight to 0");
        }

        NSLog(@"[TextSideButton] Initialized with search text: %@", text);
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (void)loadPopupHTML {
    // Set HTML subpath BEFORE loading (called by base class init)
    self.htmlSubpath = @"textSideButton";
    NSLog(@"[TextSideButton] Loading with subpath: %@", self.htmlSubpath);

    // Call parent implementation which will use the subpath
    [super loadPopupHTML];
}

- (NSString*)windowNameForLogging {
    return @"TextSideButton";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console logs from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[TextSideButton WebView %@] %@", level, msg);
}

- (void)handleBridgeMessage:(NSDictionary*)message {
    NSString* action = message[@"action"];

    // Handle button click
    if ([action isEqualToString:@"buttonClicked"]) {
        NSLog(@"[TextSideButton] Button clicked via bridge");
        [self showClickPopup];

        // Send success response
        NSString* messageId = message[@"id"];
        if (messageId) {
            [self sendBridgeResponse:messageId success:YES payload:@{}];
        }
        return;
    }

    NSLog(@"[TextSideButton] Unknown action: %@", action);
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
        NSLog(@"[TextSideButton] ERROR serializing response: %@", error);
        return;
    }

    NSString* jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    NSString* jsCode = [NSString stringWithFormat:@"window.__bridgeReceive(%@)", jsonString];

    [self.webView evaluateJavaScript:jsCode completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[TextSideButton] ERROR sending response: %@", error);
        }
    }];
}

#pragma mark - Popup Management

- (void)showClickPopup {
    BOOL isNewPopup = NO;
    if (!self.clickPopup) {
        // Create React-based popup window with observer
        self.clickPopup = [[TextSidePopup alloc] initWithObserver:self.observer];

        if (!self.clickPopup) {
            NSLog(@"[TextSideButton] ERROR: Failed to create TextSidePopup!");
            return;
        }
        isNewPopup = YES;
    }

    // Register window observers for new popup
    if (isNewPopup && self.observer) {
        // Register popup with AcademiaManager to receive activation/deactivation events
        if ([self.observer respondsToSelector:@selector(getAcademiaManager)]) {
            id academiaManager = [self.observer getAcademiaManager];
            if (academiaManager && [academiaManager respondsToSelector:@selector(registerOverlay:)]) {
                [academiaManager registerOverlay:self.clickPopup];
                NSLog(@"[TextSideButton] Registered popup with AcademiaManager");
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
        CGFloat popupWidth = 400;   // Default popup width
        CGFloat popupHeight = 500;  // Default popup height
        CGFloat verticalSpacing = 4;  // Space between button and popup

        // Position directly below button, left-aligned
        CGFloat popupX = buttonFrame.origin.x;
        CGFloat popupY = buttonFrame.origin.y - popupHeight - verticalSpacing;

        NSRect popupFrame = NSMakeRect(popupX, popupY, popupWidth, popupHeight);
        [self.clickPopup setFrame:popupFrame display:YES];
        // Save this initial position
        self.clickPopup.savedFrame = self.clickPopup.frame;
    }

    // Set visibility flag before showing (popup is being explicitly opened)
    self.clickPopup.wasVisibleBeforeHiding = YES;
    NSLog(@"[TextSideButton] Setting wasVisibleBeforeHiding to YES before showing popup");

    [self.clickPopup orderFront:nil];

    NSLog(@"[TextSideButton] Click popup shown at level: %ld", (long)self.clickPopup.level);
}

#pragma mark - OverlayWindow Protocol

- (void)updatePositionWithWordState:(WordPositionState)state {
    NSLog(@"[TextSideButton] updatePositionWithWordState called for text: %@", self.searchText);

    // Get MicrosoftWordAdapter from observer
    MicrosoftWordAdapter* adapter = nil;
    if ([self.observer respondsToSelector:@selector(getWordAdapter)]) {
        adapter = [self.observer performSelector:@selector(getWordAdapter)];
    }

    if (!adapter) {
        NSLog(@"[TextSideButton] ERROR: No adapter available");
        [self hide];
        return;
    }

    // Call findTextPosition to get text bounds
    CGRect textBounds = [adapter findTextPosition:self.searchText];

    if (CGRectEqualToRect(textBounds, CGRectZero)) {
        NSLog(@"[TextSideButton] Text not found or invalid bounds, hiding button");
        [self hide];
        return;
    }

    NSLog(@"[TextSideButton] Found text at: x=%.1f, y=%.1f, w=%.1f, h=%.1f",
          textBounds.origin.x, textBounds.origin.y, textBounds.size.width, textBounds.size.height);

    // Validate scroll area bounds
    if (CGRectIsEmpty(state.scrollAreaBounds)) {
        NSLog(@"[TextSideButton] Cannot position - scrollAreaBounds is empty");
        [self hide];
        return;
    }

    // Check if text position is within scroll area
    CGFloat scrollMinX = state.scrollAreaBounds.origin.x;
    CGFloat scrollMaxX = state.scrollAreaBounds.origin.x + state.scrollAreaBounds.size.width;
    CGFloat scrollMinY = state.scrollAreaBounds.origin.y;
    CGFloat scrollMaxY = state.scrollAreaBounds.origin.y + state.scrollAreaBounds.size.height;

    BOOL xOutOfBounds = textBounds.origin.x < scrollMinX || textBounds.origin.x > scrollMaxX;
    BOOL yOutOfBounds = textBounds.origin.y < scrollMinY || textBounds.origin.y > scrollMaxY;

    if (xOutOfBounds || yOutOfBounds) {
        NSLog(@"[TextSideButton] Text position (%.1f, %.1f) outside scroll area, hiding button",
              textBounds.origin.x, textBounds.origin.y);
        [self hide];
        return;
    }

    // Calculate button position
    CGFloat buttonWidth = self.frame.size.width;
    CGFloat buttonHeight = self.frame.size.height;

    NSScreen* primaryScreen = [NSScreen screens][0];
    CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

    // Convert from Accessibility coordinates (top-left origin) to Cocoa coordinates (bottom-left origin)
    CGFloat cocoaY = primaryScreenHeight - textBounds.origin.y;

    // Position button 8px from the left edge of the layout bounds
    CGFloat leftOffset = 8.0;
    CGFloat buttonX = state.layoutPosition.x + leftOffset;
    CGFloat buttonY = cocoaY - buttonHeight;

    NSRect newFrame = NSMakeRect(buttonX, buttonY, buttonWidth, buttonHeight);
    [self setFrame:newFrame display:YES];

    NSLog(@"[TextSideButton] Positioned at (%.1f, %.1f) next to text at (%.1f, %.1f)",
          buttonX, buttonY, textBounds.origin.x, textBounds.origin.y);

    [self show];
}

- (void)hide {
    NSLog(@"[TextSideButton] hide called");
    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[TextSideButton] show called");
    [self orderFront:nil];
}

- (NSString *)overlayIdentifier {
    return [NSString stringWithFormat:@"TextSideButton-%@", self.searchText];
}

#pragma mark - Window Lifecycle

- (void)orderOut:(id)sender {
    [super orderOut:sender];
}

@end
