#import "OverallReviewPopup.h"
#import "../../bridge.h"

@implementation OverallReviewPopup

- (instancetype)initWithCount:(int)count observer:(WordAccessibilityObserver*)observer {
    // Fixed size for popup - will contain React UI
    CGFloat width = 500;
    CGFloat height = 400;

    // Call base class initializer with size and window level
    self = [super initWithSize:CGSizeMake(width, height)
                   windowLevel:NSNormalWindowLevel + 1  // Just above Word
                      observer:observer];
    if (self) {
        self.count = count;
        self.delegate = self;

        // WAGENT-73: Initialize pending responses dictionary
        self.pendingResponses = [NSMutableDictionary dictionary];

        // Make WKWebView full-height (no native header)
        NSRect webViewFrame = NSMakeRect(0, 0, width, height);
        self.webView.frame = webViewFrame;

        // Create resize handle in bottom-right corner
        CGFloat handleSize = 20;
        NSRect handleFrame = NSMakeRect(width - handleSize, 0, handleSize, handleSize);
        self.resizeHandle = [[ResizeHandleView alloc] initWithFrame:handleFrame window:self];
        [self.contentView addSubview:self.resizeHandle];
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (void)loadPopupHTML {
    // Set HTML subpath BEFORE loading (called by base class init)
    self.htmlSubpath = @"overallReview";
    NSLog(@"[OverallReviewPopup] Loading with subpath: %@", self.htmlSubpath);

    // Call parent implementation which will use the subpath
    [super loadPopupHTML];
}

- (NSString*)windowNameForLogging {
    return @"OverallReviewPopup";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console logs from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[OverallReviewPopup WebView %@] %@", level, msg);
}

- (void)handleBridgeMessage:(NSDictionary*)message {
    NSString* action = message[@"action"];

    // WAGENT-73: Handle ACK from JavaScript that pending request is registered
    if ([action isEqualToString:@"request-registered"]) {
        NSDictionary* payload = message[@"payload"];
        NSString* requestId = payload[@"requestId"];

        NSLog(@"[OverallReviewPopup] Received ACK for request: %@", requestId);

        // Check if we have a pending response for this request
        NSString* pendingResponse = self.pendingResponses[requestId];
        if (pendingResponse) {
            NSLog(@"[OverallReviewPopup] Sending pending response for: %@", requestId);

            // Send the response immediately now that we know JS is ready
            [self.webView evaluateJavaScript:pendingResponse completionHandler:^(id result, NSError *error) {
                if (error) {
                    NSLog(@"[OverallReviewPopup] ERROR sending response: %@", error);
                } else {
                    NSLog(@"[OverallReviewPopup] Response sent successfully");
                }
            }];

            // Remove from pending
            [self.pendingResponses removeObjectForKey:requestId];
        } else {
            NSLog(@"[OverallReviewPopup] No pending response found for: %@", requestId);
        }

        return;
    }

    // Handle button clicks
    if ([action isEqualToString:@"buttonClick"]) {
        NSLog(@"[OverallReviewPopup] ===== buttonClick DEBUG =====");
        NSLog(@"[OverallReviewPopup] Message ID: %@", message[@"id"]);
        NSLog(@"[OverallReviewPopup] Full message: %@", message);

        // Verify message ID exists
        NSString* messageId = message[@"id"];
        if (!messageId || messageId.length == 0) {
            NSLog(@"[OverallReviewPopup] ERROR: Missing or empty message ID!");
            return;
        }

        NSDictionary* payload = message[@"payload"];
        NSString* btnAction = payload[@"action"];
        NSNumber* count = payload[@"count"];

        NSLog(@"[OverallReviewPopup] Button action: %@, count: %@", btnAction, count);

        // Forward to observer which will send to main.ts
        if (self.observer) {
            id observer = self.observer;
            if ([btnAction isEqualToString:@"seeMore"]) {
                NSString* msg = [NSString stringWithFormat:@"seeMore|count:%@", count];
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [observer performSelector:@selector(handleButtonClickWithAction:text:)
                               withObject:@"seeMore" withObject:msg];
                #pragma clang diagnostic pop
            } else if ([btnAction isEqualToString:@"dismiss"]) {
                NSString* msg = [NSString stringWithFormat:@"dismiss|count:%@", count];
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [observer performSelector:@selector(handleButtonClickWithAction:text:)
                               withObject:@"dismiss" withObject:msg];
                #pragma clang diagnostic pop
                // Clear visibility flag before hiding (user manually closed)
                self.wasVisibleBeforeHiding = NO;
                NSLog(@"[OverallReviewPopup] User dismissed popup - clearing visibility flag");
                [self orderOut:nil];
            }
        }

        // WAGENT-73: Store response and wait for ACK from JavaScript
        // This replaces the 10ms arbitrary delay with proper acknowledgment pattern
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

        NSLog(@"[OverallReviewPopup] Storing response, waiting for ACK");
        self.pendingResponses[messageId] = responseJS;

        // WAGENT-73: Add timeout fallback (50ms) in case ACK never arrives
        // This ensures we don't block forever if something goes wrong
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            NSString* pendingResponse = self.pendingResponses[messageId];
            if (pendingResponse) {
                NSLog(@"[OverallReviewPopup] ACK timeout - sending response anyway");

                [self.webView evaluateJavaScript:pendingResponse completionHandler:^(id result, NSError *error) {
                    if (error) {
                        NSLog(@"[OverallReviewPopup] ERROR sending response: %@", error);
                        NSLog(@"[OverallReviewPopup] JavaScript was: %@", pendingResponse);
                    } else {
                        NSLog(@"[OverallReviewPopup] Response sent successfully (fallback)");
                    }
                }];

                // Remove from pending
                [self.pendingResponses removeObjectForKey:messageId];
            }
        });
    }
    // Handle text position search
    else if ([action isEqualToString:@"searchTextPosition"]) {
        NSLog(@"[OverallReviewPopup] ===== searchTextPosition DEBUG =====");
        NSLog(@"[OverallReviewPopup] Message ID: %@", message[@"id"]);
        NSLog(@"[OverallReviewPopup] Full message: %@", message);

        NSDictionary* payload = message[@"payload"];
        NSString* searchText = payload[@"text"];
        NSLog(@"[OverallReviewPopup] Search text: %@", searchText);

        // CRITICAL: Return focus to MS Word before searching
        // The search needs Word's document to be the focused AXTextArea
        if (self.observer && [self.observer respondsToSelector:@selector(getWordPID)]) {
            pid_t wordPID = [self.observer getWordPID];
            NSRunningApplication* wordApp = [NSRunningApplication runningApplicationWithProcessIdentifier:wordPID];
            if (wordApp) {
                [wordApp activateWithOptions:NSApplicationActivateIgnoringOtherApps];
                NSLog(@"[OverallReviewPopup] Activated MS Word");

                // Give Word a moment to come to the front
                [NSThread sleepForTimeInterval:0.1];

                // Actively set focus on the document
                if ([self.observer respondsToSelector:@selector(focusDocument)]) {
                    BOOL focusSet = [self.observer focusDocument];
                    if (focusSet) {
                        NSLog(@"[OverallReviewPopup] Successfully focused document");
                    } else {
                        NSLog(@"[OverallReviewPopup] WARNING: Could not set document focus");
                    }
                }

                // Poll for up to 1 second to verify Word document (AXTextArea) has focus
                BOOL documentHasFocus = NO;
                for (int i = 0; i < 10; i++) {
                    [NSThread sleepForTimeInterval:0.1];

                    // Check if Word document has focus
                    if ([self.observer respondsToSelector:@selector(getWordApp)]) {
                        AXUIElementRef wordAppElement = [self.observer getWordApp];
                        AXUIElementRef testElement = NULL;
                        AXError testError = AXUIElementCopyAttributeValue(wordAppElement,
                                                                           kAXFocusedUIElementAttribute,
                                                                           (CFTypeRef*)&testElement);
                        if (testError == kAXErrorSuccess && testElement) {
                            CFTypeRef roleValue = NULL;
                            AXUIElementCopyAttributeValue(testElement, kAXRoleAttribute, &roleValue);
                            NSString* role = (__bridge_transfer NSString*)roleValue;
                            CFRelease(testElement);

                            if ([role isEqualToString:@"AXTextArea"]) {
                                NSLog(@"[OverallReviewPopup] Verified document has focus after %dms", (i+1) * 100);
                                documentHasFocus = YES;
                                break;
                            }
                        }
                    }
                }

                if (!documentHasFocus) {
                    NSLog(@"[OverallReviewPopup] WARNING: Could not verify document focus after 1000ms");
                }
            }
        }

        // Call the observer to search in Word document
        NSDictionary* result = nil;
        if (self.observer && [self.observer respondsToSelector:@selector(findTextPosition:)]) {
            result = [self.observer findTextPosition:searchText];
        }

        if (!result) {
            result = @{@"found": @NO};
        }

        // Log the search result
        NSLog(@"[OverallReviewPopup] findTextPosition result: %@", result);
        NSLog(@"[OverallReviewPopup] Found: %@", result[@"found"]);
        if ([result[@"found"] boolValue]) {
            NSLog(@"[OverallReviewPopup] Match at character index %@", result[@"charIndex"]);
            NSLog(@"[OverallReviewPopup] Bounds: x=%@, y=%@, w=%@, h=%@",
                  result[@"x"], result[@"y"], result[@"width"], result[@"height"]);
        }

        // Send response back to JavaScript
        NSString* found = [result[@"found"] boolValue] ? @"true" : @"false";
        NSString* text = result[@"text"] ?: @"";
        NSNumber* charIndex = result[@"charIndex"] ?: @0;
        NSNumber* x = result[@"x"] ?: @0;
        NSNumber* y = result[@"y"] ?: @0;
        NSNumber* width = result[@"width"] ?: @0;
        NSNumber* height = result[@"height"] ?: @0;

        NSString* responseJS = [NSString stringWithFormat:@
            "window.__bridgeReceive({"
            "  id: '%@',"
            "  type: 'response',"
            "  action: 'searchTextPosition',"
            "  payload: {"
            "    found: %@,"
            "    text: '%@',"
            "    charIndex: %@,"
            "    x: %@,"
            "    y: %@,"
            "    width: %@,"
            "    height: %@"
            "  }"
            "});",
            message[@"id"], found, text, charIndex, x, y, width, height];

        NSLog(@"[OverallReviewPopup] Response JavaScript:");
        NSLog(@"%@", responseJS);

        // Send response immediately - compatibility layer will queue if needed
        [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
            if (error) {
                NSLog(@"[OverallReviewPopup] ERROR evaluating JavaScript: %@", error);
                NSLog(@"[OverallReviewPopup] JavaScript was: %@", responseJS);
            } else {
                NSLog(@"[OverallReviewPopup] JavaScript executed successfully");
            }
        }];
    }
    // Note: 'close' action removed - now handled by native close button
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // WAGENT-78: Replace arbitrary 500ms delay with proper readiness check
    // Check if React/window.__bridgeReceive is ready before sending content
    __block int attemptCount = 0;
    __block __weak void (^weakTryUpdate)(void);
    void (^tryUpdate)(void);

    tryUpdate = ^{
        attemptCount++;
        NSLog(@"[OverallReviewPopup] Checking if bridge is ready (attempt %d)", attemptCount);

        // Check if window.__bridgeReceive exists (indicating bridge is ready)
        NSString* checkScript = @"typeof window.__bridgeReceive === 'function'";
        [self.webView evaluateJavaScript:checkScript completionHandler:^(id result, NSError *error) {
            BOOL bridgeReady = [result boolValue];
            NSLog(@"[OverallReviewPopup] Bridge ready: %d", bridgeReady);

            if (bridgeReady) {
                // Bridge is ready, send initial content
                [self updateContentWithCount:self.count];
            } else if (attemptCount < 10) {
                // Not ready yet, try again after a short delay
                void (^strongTryUpdate)(void) = weakTryUpdate;
                if (strongTryUpdate) {
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                                 dispatch_get_main_queue(), strongTryUpdate);
                }
            } else {
                NSLog(@"[OverallReviewPopup] ERROR: Bridge not ready after %d attempts", attemptCount);
            }
        }];
    };
    weakTryUpdate = tryUpdate;

    // Start checking immediately
    tryUpdate();
}

#pragma mark - Content Update

- (void)updateContentWithCount:(int)count {
    self.count = count;

    // Send count data to React via bridge (no routing needed with dedicated entry point)
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
        "        count: %d, "
        "        text: 'Count: %d' "
        "      }, "
        "      timestamp: Date.now() "
        "    }); "
        "    console.log('[Native->JS] Bridge message sent successfully'); "
        "  } else { "
        "    console.error('[Native->JS] Bridge not found'); "
        "  } "
        "} catch (e) { "
        "  console.error('[Native->JS] Error sending message:', e); "
        "}", count, count];

    [self.webView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[OverallReviewPopup] Error evaluating JavaScript: %@", error.localizedDescription);
        }
    }];
}

#pragma mark - Close Button Handler

- (void)handleCloseButton:(id)sender {
    NSLog(@"[OverallReviewPopup] Close button clicked");

    // Clear visibility flag before closing (user manually closed)
    self.wasVisibleBeforeHiding = NO;
    NSLog(@"[OverallReviewPopup] User closed popup - clearing visibility flag");

    // Close the window
    [self orderOut:nil];
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
    // ClickPopupWindow is positioned relative to its parent button, not Word state
    // The popup's position is managed by the parent button (OverallReviewButton)
    // This method is a no-op for popup windows

    NSLog(@"[OverallReviewPopup] updatePositionWithWordState called - position managed by parent button");
}

- (void)hide {
    NSLog(@"[OverallReviewPopup] hide called");
    // Save current visibility state before hiding
    self.wasVisibleBeforeHiding = [self isVisible];
    NSLog(@"[OverallReviewPopup] Saving visibility state: %d", self.wasVisibleBeforeHiding);
    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[OverallReviewPopup] show called (wasVisibleBeforeHiding: %d)", self.wasVisibleBeforeHiding);
    // Only show if the popup was visible before hiding (e.g., during Word deactivation)
    // This prevents auto-showing the popup when it was manually closed by the user
    if (self.wasVisibleBeforeHiding) {
        [self orderFront:nil];
    } else {
        NSLog(@"[OverallReviewPopup] Skipping show - popup was not visible before hiding");
    }
}

// isVisible is inherited from NSWindow - no need to override

- (NSString *)overlayIdentifier {
    return @"OverallReviewPopup";
}

@end
