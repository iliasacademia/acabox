#import "AcademiaNotificationsPopup.h"
#import "AcademiaNotificationsButton.h"

@implementation AcademiaNotificationsPopup

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Size for notification popover - 700x600 to match design
    CGFloat width = 370;
    CGFloat height = 460;

    // Call base class initializer with size and window level
    self = [super initWithSize:CGSizeMake(width, height)
                  windowLevel:NSFloatingWindowLevel + 1  // Above the button
                     observer:observer];
    if (self) {
        NSLog(@"[AcademiaNotificationsPopup] Initialized as non-activating panel");

        // Add message handler for notification actions
        [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"notificationAction"];
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (void)loadPopupHTML {
    // Set HTML subpath BEFORE loading (called by base class init)
    self.htmlSubpath = @"academiaNotifications";
    NSLog(@"[AcademiaNotificationsPopup] Loading with subpath: %@", self.htmlSubpath);

    // Call parent implementation which will use the subpath
    [super loadPopupHTML];
}

- (NSString*)windowNameForLogging {
    return @"AcademiaNotificationsPopup";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console messages from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[AcademiaNotificationsPopup/JS/%@] %@", level, msg);
}

- (void)handleBridgeMessage:(NSDictionary*)message {
    NSString* action = message[@"action"];
    NSString* msgType = message[@"type"];

    NSLog(@"[Bridge] Received: action=%@, type=%@", action, msgType);

    // Handle bridge-ready signal
    if ([action isEqualToString:@"bridge-ready"]) {
        NSLog(@"[Bridge] JavaScript bridge is ready!");
        return;
    }

    // Handle closeWindow action
    if ([action isEqualToString:@"closeWindow"]) {
        NSLog(@"[AcademiaNotificationsPopup] Close window requested");

        // Send response back to JavaScript
        NSString* messageId = message[@"id"];
        if (messageId) {
            NSString* responseJS = [NSString stringWithFormat:@
                "window.__bridgeReceive({"
                "  id: '%@',"
                "  from: 'native',"
                "  to: 'notifications-popup',"
                "  type: 'response',"
                "  action: 'closeWindow',"
                "  payload: {success: true},"
                "  timestamp: Date.now()"
                "});",
                messageId];

            [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
                if (error) {
                    NSLog(@"[AcademiaNotificationsPopup] ERROR sending response: %@", error);
                }
            }];
        }

        // Close the window
        [self orderOut:nil];
        return;
    }

    // Handle notificationAction (for new bridge system)
    if ([action isEqualToString:@"notificationAction"]) {
        NSDictionary* payload = message[@"payload"];
        NSString* notifAction = payload[@"action"];
        NSNumber* notificationId = payload[@"notificationId"];

        NSLog(@"[Bridge] Notification action: %@ for ID: %@", notifAction, notificationId);

        // TODO: Handle notification actions (mark as read, dismiss, navigate, etc.)
        // This will be implemented when we integrate with the notification system

        return;
    }
}

#pragma mark - Message Handling

- (void)userContentController:(WKUserContentController*)userContentController
      didReceiveScriptMessage:(WKScriptMessage*)message {
    // Handle old-style direct message handlers (notificationAction)
    if ([message.name isEqualToString:@"notificationAction"]) {
        NSDictionary* body = message.body;
        NSLog(@"[AcademiaNotificationsPopup] notificationAction: %@", body);

        // Forward to handleBridgeMessage for unified handling
        [self handleBridgeMessage:@{
            @"action": @"notificationAction",
            @"payload": body ?: @{}
        }];
        return;
    }

    // Delegate to base class for standard handlers (bridge, consoleLog)
    [super userContentController:userContentController didReceiveScriptMessage:message];
}

#pragma mark - OverlayWindow Protocol

- (void)updatePositionWithWordState:(WordPositionState)state {
    // AcademiaNotificationsPopup is positioned relative to its parent button (ButtonOverlayWindow)
    // The popup's position is managed by the parent button
    // This method is a no-op for popup windows

    NSLog(@"[AcademiaNotificationsPopup] updatePositionWithWordState called - position managed by parent button");
    [self show];
}

- (void)hide {
    NSLog(@"[AcademiaNotificationsPopup] hide called");
    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[AcademiaNotificationsPopup] show called");
    [self orderFront:nil];
}

// isVisible is inherited from NSWindow - no need to override

- (NSString *)overlayIdentifier {
    return @"AcademiaNotificationsPopup";
}

@end
