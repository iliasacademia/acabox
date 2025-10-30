#import "ClickPopupWindow.h"
#import "../../bridge.h"

@implementation ClickPopupWindow

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

        // Define header height
        CGFloat headerHeight = 48;

        // Create native header view for dragging
        NSRect headerFrame = NSMakeRect(0, height - headerHeight, width, headerHeight);
        self.nativeHeader = [[NativeHeaderView alloc] initWithFrame:headerFrame window:self];
        self.nativeHeader.target = self;
        self.nativeHeader.closeAction = @selector(handleCloseButton:);
        [self.nativeHeader updateBadgeCount:count];

        // Add header view to content view
        [self.contentView addSubview:self.nativeHeader];

        // Adjust WKWebView frame to sit below the header
        NSRect webViewFrame = NSMakeRect(0, 0, width, height - headerHeight);
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

- (NSString*)windowNameForLogging {
    return @"ClickPopupWindow";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console logs from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[ClickPopupWindow WebView %@] %@", level, msg);
}

- (void)handleBridgeMessage:(NSDictionary*)message {
    NSString* action = message[@"action"];

    // Handle button clicks
    if ([action isEqualToString:@"buttonClick"]) {
        NSLog(@"[ClickPopupWindow] ===== buttonClick DEBUG =====");
        NSLog(@"[ClickPopupWindow] Message ID: %@", message[@"id"]);
        NSLog(@"[ClickPopupWindow] Full message: %@", message);

        // Verify message ID exists
        NSString* messageId = message[@"id"];
        if (!messageId || messageId.length == 0) {
            NSLog(@"[ClickPopupWindow] ERROR: Missing or empty message ID!");
            return;
        }

        NSDictionary* payload = message[@"payload"];
        NSString* btnAction = payload[@"action"];
        NSNumber* count = payload[@"count"];

        NSLog(@"[ClickPopupWindow] Button action: %@, count: %@", btnAction, count);

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
                // Also hide the popup
                [self orderOut:nil];
            }
        }

        // Add a small delay before sending response to avoid race condition
        // This ensures the JavaScript side has completed registering the pending request
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.01 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            // Send response back to JavaScript with complete message structure
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

            NSLog(@"[ClickPopupWindow] Sending response JavaScript:");
            NSLog(@"%@", responseJS);

            [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
                if (error) {
                    NSLog(@"[ClickPopupWindow] ERROR sending response: %@", error);
                    NSLog(@"[ClickPopupWindow] JavaScript was: %@", responseJS);
                } else {
                    NSLog(@"[ClickPopupWindow] Response sent successfully");
                }
            }];
        });
    }
    // Handle text position search
    else if ([action isEqualToString:@"searchTextPosition"]) {
        NSLog(@"[ClickPopupWindow] ===== searchTextPosition DEBUG =====");
        NSLog(@"[ClickPopupWindow] Message ID: %@", message[@"id"]);
        NSLog(@"[ClickPopupWindow] Full message: %@", message);

        NSDictionary* payload = message[@"payload"];
        NSString* searchText = payload[@"text"];
        NSLog(@"[ClickPopupWindow] Search text: %@", searchText);

        // CRITICAL: Return focus to MS Word before searching
        // The search needs Word's document to be the focused AXTextArea
        if (self.observer && [self.observer respondsToSelector:@selector(getWordPID)]) {
            pid_t wordPID = [self.observer getWordPID];
            NSRunningApplication* wordApp = [NSRunningApplication runningApplicationWithProcessIdentifier:wordPID];
            if (wordApp) {
                [wordApp activateWithOptions:NSApplicationActivateIgnoringOtherApps];
                NSLog(@"[ClickPopupWindow] Activated MS Word");

                // Give Word a moment to come to the front
                [NSThread sleepForTimeInterval:0.1];

                // Actively set focus on the document
                if ([self.observer respondsToSelector:@selector(focusDocument)]) {
                    BOOL focusSet = [self.observer focusDocument];
                    if (focusSet) {
                        NSLog(@"[ClickPopupWindow] Successfully focused document");
                    } else {
                        NSLog(@"[ClickPopupWindow] WARNING: Could not set document focus");
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
                                NSLog(@"[ClickPopupWindow] Verified document has focus after %dms", (i+1) * 100);
                                documentHasFocus = YES;
                                break;
                            }
                        }
                    }
                }

                if (!documentHasFocus) {
                    NSLog(@"[ClickPopupWindow] WARNING: Could not verify document focus after 1000ms");
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
        NSLog(@"[ClickPopupWindow] findTextPosition result: %@", result);
        NSLog(@"[ClickPopupWindow] Found: %@", result[@"found"]);
        if ([result[@"found"] boolValue]) {
            NSLog(@"[ClickPopupWindow] Match at character index %@", result[@"charIndex"]);
            NSLog(@"[ClickPopupWindow] Bounds: x=%@, y=%@, w=%@, h=%@",
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

        NSLog(@"[ClickPopupWindow] Response JavaScript:");
        NSLog(@"%@", responseJS);

        // Send response immediately - compatibility layer will queue if needed
        [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
            if (error) {
                NSLog(@"[ClickPopupWindow] ERROR evaluating JavaScript: %@", error);
                NSLog(@"[ClickPopupWindow] JavaScript was: %@", responseJS);
            } else {
                NSLog(@"[ClickPopupWindow] JavaScript executed successfully");
            }
        }];
    }
    // Note: 'close' action removed - now handled by native close button
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // Wait for React to initialize then send initial content
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self updateContentWithCount:self.count];
    });
}

#pragma mark - Content Update

- (void)updateContentWithCount:(int)count {
    self.count = count;

    // Update native header badge
    [self.nativeHeader updateBadgeCount:count];

    // Send count data to React via bridge with type: 'suggestions'
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
        "        type: 'suggestions', "
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
            NSLog(@"[ClickPopupWindow] Error evaluating JavaScript: %@", error.localizedDescription);
        }
    }];
}

#pragma mark - Close Button Handler

- (void)handleCloseButton:(id)sender {
    NSLog(@"[ClickPopupWindow] Close button clicked");

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

    // Header stays at fixed height (48pt) at the top
    CGFloat headerHeight = 48;
    NSRect headerFrame = NSMakeRect(0, height - headerHeight, width, headerHeight);
    self.nativeHeader.frame = headerFrame;

    // WebView fills remaining space below header
    NSRect webViewFrame = NSMakeRect(0, 0, width, height - headerHeight);
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

@end
