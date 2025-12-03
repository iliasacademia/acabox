#import "AcademiaNotificationsPopup.h"
#import "AcademiaNotificationsButton.h"
#import "../../bridge.h"  // For WordAccessibilityObserver full interface

@implementation AcademiaNotificationsPopup

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Size for notification popover - default height for 2 sections
    // Height will be resized by React if there's a pending notification (3 sections)
    CGFloat width = 370;
    CGFloat height = 280;  // Default: 2 sections (use 376 for 3 sections)

    // Call base class initializer with size and window level
    self = [super initWithSize:CGSizeMake(width, height)
                  windowLevel:NSFloatingWindowLevel + 1  // Above the button
                     observer:observer];
    if (self) {
        NSLog(@"[AcademiaNotificationsPopup] Initialized as non-activating panel");

        // Disable dragging for the notifications popup
        if ([self.webView isKindOfClass:NSClassFromString(@"DraggableAcceptingWebView")]) {
            [self.webView setValue:@0 forKey:@"dragHandleHeight"];
            NSLog(@"[AcademiaNotificationsPopup] Dragging disabled");
        }

        // Add message handler for notification actions
        [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"notificationAction"];
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (void)loadPopupHTML {
    // Set HTML subpath BEFORE loading (called by base class init)
    self.htmlSubpath = @"academiaNotifications";

    // Get PID from observer and pass as query param for notification filtering
    if (self.observer) {
        pid_t wordPID = [self.observer getWordPID];
        self.queryParams = @{@"pid": [NSString stringWithFormat:@"%d", wordPID]};
        NSLog(@"[AcademiaNotificationsPopup] Loading with subpath: %@, pid: %d", self.htmlSubpath, wordPID);
    } else {
        NSLog(@"[AcademiaNotificationsPopup] Loading with subpath: %@ (no observer, no PID)", self.htmlSubpath);
    }

    // Call parent implementation which will use the subpath and queryParams
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

    // Handle resizeWindow action
    if ([action isEqualToString:@"resizeWindow"]) {
        NSDictionary* payload = message[@"payload"];
        NSNumber* heightNum = payload[@"height"];

        if (heightNum) {
            CGFloat newHeight = [heightNum floatValue];
            NSRect frame = self.frame;

            // Keep bottom-left fixed, grow upward (don't adjust origin.y)
            // macOS coordinate system has origin at bottom-left, y increases upward
            frame.size.height = newHeight;

            [self setFrame:frame display:YES animate:YES];
            NSLog(@"[AcademiaNotificationsPopup] Resized to height: %.0f (growing upward)", newHeight);
        }

        // Send response back to JavaScript
        NSString* messageId = message[@"id"];
        if (messageId) {
            NSString* responseJS = [NSString stringWithFormat:@
                "window.__bridgeReceive({"
                "  id: '%@',"
                "  from: 'native',"
                "  to: 'notifications-popup',"
                "  type: 'response',"
                "  action: 'resizeWindow',"
                "  payload: {success: true},"
                "  timestamp: Date.now()"
                "});",
                messageId];

            [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
                if (error) {
                    NSLog(@"[AcademiaNotificationsPopup] ERROR sending resize response: %@", error);
                }
            }];
        }

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

    // Handle navigateToPage action
    if ([action isEqualToString:@"navigateToPage"]) {
        NSDictionary* payload = message[@"payload"];
        NSLog(@"[AcademiaNotificationsPopup] Navigate to page: %@", payload);

        // Forward to observer's button click callback
        // Format: "navigateToPage|{json_payload}"
        NSError* jsonError = nil;
        NSData* jsonData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&jsonError];
        if (jsonData && self.observer) {
            NSString* jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
            [self.observer handleButtonClickWithAction:@"navigateToPage" text:jsonString];
        } else if (jsonError) {
            NSLog(@"[AcademiaNotificationsPopup] Error serializing payload: %@", jsonError);
        }

        // Send response back to JavaScript
        NSString* messageId = message[@"id"];
        if (messageId) {
            NSString* responseJS = [NSString stringWithFormat:@
                "window.__bridgeReceive({"
                "  id: '%@',"
                "  from: 'native',"
                "  to: 'notifications-popup',"
                "  type: 'response',"
                "  action: 'navigateToPage',"
                "  payload: {success: true},"
                "  timestamp: Date.now()"
                "});",
                messageId];

            [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
                if (error) {
                    NSLog(@"[AcademiaNotificationsPopup] ERROR sending navigateToPage response: %@", error);
                }
            }];
        }

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
