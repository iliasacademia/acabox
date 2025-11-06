#import "TextSidePopup.h"
#import "../../bridge.h"

@implementation TextSidePopup

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Fixed initial size for popup - will contain React UI
    CGFloat width = 400;
    CGFloat height = 500;

    // Call base class initializer with size and window level
    self = [super initWithSize:CGSizeMake(width, height)
                   windowLevel:NSFloatingWindowLevel + 1  // Above button (NSFloatingWindowLevel)
                      observer:observer];
    if (self) {
        self.delegate = self;

        // Initialize savedFrame to ensure default positioning on first open
        self.savedFrame = NSZeroRect;

        // Initialize pending responses dictionary
        self.pendingResponses = [NSMutableDictionary dictionary];

        // Make WKWebView full-height (no native header)
        NSRect webViewFrame = NSMakeRect(0, 0, width, height);
        self.webView.frame = webViewFrame;

        // Create resize handle in bottom-right corner
        CGFloat handleSize = 20;
        NSRect handleFrame = NSMakeRect(width - handleSize, 0, handleSize, handleSize);
        self.resizeHandle = [[ResizeHandleView alloc] initWithFrame:handleFrame window:self];
        [self.contentView addSubview:self.resizeHandle];

        // Set window size constraints
        [self setMinSize:NSMakeSize(300, 250)];
        [self setMaxSize:NSMakeSize(800, 800)];
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (void)loadPopupHTML {
    // Set HTML subpath BEFORE loading (called by base class init)
    self.htmlSubpath = @"textSide";
    NSLog(@"[TextSidePopup] Loading with subpath: %@", self.htmlSubpath);

    // Call parent implementation which will use the subpath
    [super loadPopupHTML];
}

- (NSString*)windowNameForLogging {
    return @"TextSidePopup";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console logs from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[TextSidePopup WebView %@] %@", level, msg);
}

- (void)handleBridgeMessage:(NSDictionary*)message {
    NSString* action = message[@"action"];

    // Handle ACK from JavaScript that pending request is registered
    if ([action isEqualToString:@"request-registered"]) {
        NSDictionary* payload = message[@"payload"];
        NSString* requestId = payload[@"requestId"];

        NSLog(@"[TextSidePopup] Received ACK for request: %@", requestId);

        // Check if we have a pending response for this request
        NSString* pendingResponse = self.pendingResponses[requestId];
        if (pendingResponse) {
            NSLog(@"[TextSidePopup] Sending pending response for: %@", requestId);

            // Send the response immediately now that we know JS is ready
            [self.webView evaluateJavaScript:pendingResponse completionHandler:^(id result, NSError *error) {
                if (error) {
                    NSLog(@"[TextSidePopup] ERROR sending response: %@", error);
                } else {
                    NSLog(@"[TextSidePopup] Response sent successfully");
                }
            }];

            // Remove from pending
            [self.pendingResponses removeObjectForKey:requestId];
        } else {
            NSLog(@"[TextSidePopup] No pending response found for: %@", requestId);
        }

        return;
    }

    // Handle button clicks
    if ([action isEqualToString:@"buttonClick"]) {
        NSLog(@"[TextSidePopup] ===== buttonClick DEBUG =====");
        NSLog(@"[TextSidePopup] Message ID: %@", message[@"id"]);
        NSLog(@"[TextSidePopup] Full message: %@", message);

        // Verify message ID exists
        NSString* messageId = message[@"id"];
        if (!messageId || messageId.length == 0) {
            NSLog(@"[TextSidePopup] ERROR: Missing or empty message ID!");
            return;
        }

        NSDictionary* payload = message[@"payload"];
        NSString* btnAction = payload[@"action"];

        NSLog(@"[TextSidePopup] Button action: %@", btnAction);

        // Handle close action
        if ([btnAction isEqualToString:@"close"]) {
            // Clear visibility flag before hiding (user manually closed)
            self.wasVisibleBeforeHiding = NO;
            // Reset saved frame to restore default position and size on next open
            self.savedFrame = NSZeroRect;
            NSLog(@"[TextSidePopup] User closed popup - clearing visibility flag and resetting position");
            [self orderOut:nil];
        }

        // Store response and wait for ACK from JavaScript
        NSString* responseJS = [NSString stringWithFormat:@
            "window.__bridgeReceive({"
            "  id: '%@',"
            "  from: 'native',"
            "  to: 'popup',"
            "  type: 'response',"
            "  action: 'buttonClick',"
            "  payload: {success: true},"
            "  timestamp: Date.now()"
            "});",
            messageId];

        NSLog(@"[TextSidePopup] Storing response, waiting for ACK");
        self.pendingResponses[messageId] = responseJS;

        // Add timeout fallback (50ms) in case ACK never arrives
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            NSString* pendingResponse = self.pendingResponses[messageId];
            if (pendingResponse) {
                NSLog(@"[TextSidePopup] ACK timeout - sending response anyway");

                [self.webView evaluateJavaScript:pendingResponse completionHandler:^(id result, NSError *error) {
                    if (error) {
                        NSLog(@"[TextSidePopup] ERROR sending response: %@", error);
                        NSLog(@"[TextSidePopup] JavaScript was: %@", pendingResponse);
                    } else {
                        NSLog(@"[TextSidePopup] Response sent successfully (fallback)");
                    }
                }];

                // Remove from pending
                [self.pendingResponses removeObjectForKey:messageId];
            }
        });
    }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // Check if React/window.__bridgeReceive is ready before sending content
    __block int attemptCount = 0;
    __block __weak void (^weakTryUpdate)(void);
    void (^tryUpdate)(void);

    tryUpdate = ^{
        attemptCount++;
        NSLog(@"[TextSidePopup] Checking if bridge is ready (attempt %d)", attemptCount);

        // Check if window.__bridgeReceive exists (indicating bridge is ready)
        NSString* checkScript = @"typeof window.__bridgeReceive === 'function'";
        [self.webView evaluateJavaScript:checkScript completionHandler:^(id result, NSError *error) {
            BOOL bridgeReady = [result boolValue];
            NSLog(@"[TextSidePopup] Bridge ready: %d", bridgeReady);

            if (bridgeReady) {
                // Bridge is ready, send initial content if we have data
                if (self.citationData) {
                    [self updateContentWithData:self.citationData];
                }
            } else if (attemptCount < 10) {
                // Not ready yet, try again after a short delay
                void (^strongTryUpdate)(void) = weakTryUpdate;
                if (strongTryUpdate) {
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                                 dispatch_get_main_queue(), strongTryUpdate);
                }
            } else {
                NSLog(@"[TextSidePopup] ERROR: Bridge not ready after %d attempts", attemptCount);
            }
        }];
    };
    weakTryUpdate = tryUpdate;

    // Start checking immediately
    tryUpdate();
}

#pragma mark - Content Update

- (void)updateContentWithData:(NSString*)data {
    self.citationData = data;

    // Send citation data to React via bridge
    NSString* js = [NSString stringWithFormat:@
        "try { "
        "  console.log('[Native->JS] Sending updateContent via bridge'); "
        "  if (window.__bridgeReceive) { "
        "    window.__bridgeReceive({ "
        "      id: 'native-' + Date.now(), "
        "      from: 'native', "
        "      to: 'popup', "
        "      type: 'event', "
        "      action: 'updateContent', "
        "      payload: { "
        "        citationData: %@ "
        "      }, "
        "      timestamp: Date.now() "
        "    }); "
        "    console.log('[Native->JS] Bridge message sent successfully'); "
        "  } else { "
        "    console.error('[Native->JS] Bridge not found'); "
        "  } "
        "} catch (e) { "
        "  console.error('[Native->JS] Error sending message:', e); "
        "}", data ?: @"null"];

    [self.webView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[TextSidePopup] Error evaluating JavaScript: %@", error.localizedDescription);
        }
    }];
}

#pragma mark - Window Position and Size Tracking

- (void)windowDidMove:(NSNotification *)notification {
    // Save current position whenever window moves
    self.savedFrame = self.frame;
}

- (void)windowDidResize:(NSNotification *)notification {
    // Get current window size
    NSRect windowFrame = self.frame;
    CGFloat width = windowFrame.size.width;
    CGFloat height = windowFrame.size.height;

    // WebView fills entire window
    NSRect webViewFrame = NSMakeRect(0, 0, width, height);
    self.webView.frame = webViewFrame;

    // Reposition resize handle to stay in bottom-right corner
    CGFloat handleSize = 20;
    NSRect handleFrame = NSMakeRect(width - handleSize, 0, handleSize, handleSize);
    self.resizeHandle.frame = handleFrame;

    // Save current frame (position and size) whenever window resizes
    self.savedFrame = self.frame;
}

#pragma mark - Cleanup

- (void)dealloc {
    // Base class handles WKWebView cleanup
}

#pragma mark - OverlayWindow Protocol

- (void)updatePositionWithWordState:(WordPositionState)state {
    // TextSidePopup position is managed by its parent TextSideButton
    // This method is a no-op for this popup window
    NSLog(@"[TextSidePopup] updatePositionWithWordState called - position managed by parent button");
}

- (void)hide {
    NSLog(@"[TextSidePopup] hide called");
    // Save current visibility state before hiding
    self.wasVisibleBeforeHiding = [self isVisible];
    NSLog(@"[TextSidePopup] Saving visibility state: %d", self.wasVisibleBeforeHiding);
    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[TextSidePopup] show called (wasVisibleBeforeHiding: %d)", self.wasVisibleBeforeHiding);
    // Only show if the popup was visible before hiding (e.g., during Word deactivation)
    // This prevents auto-showing the popup when it was manually closed by the user
    if (self.wasVisibleBeforeHiding) {
        [self orderFront:nil];
    } else {
        NSLog(@"[TextSidePopup] Skipping show - popup was not visible before hiding");
    }
}

// isVisible is inherited from NSWindow - no need to override

- (NSString *)overlayIdentifier {
    return @"TextSidePopup";
}

@end
