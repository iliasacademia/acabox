#import "TextPopupWindow.h"
#import "ButtonOverlayWindow.h"

@implementation TextPopupWindow

- (instancetype)initWithText:(NSString*)text {
    // Fixed size for popup - will contain React UI with buttons
    CGFloat width = 380;
    CGFloat height = 220;

    // Call base class initializer with size and window level
    self = [super initWithSize:CGSizeMake(width, height)
                   windowLevel:NSFloatingWindowLevel + 1  // Above the button
                      observer:nil];  // Observer will be set via buttonWindow
    if (self) {
        // Store the initial text
        self.currentText = text;
        self.isProcessingClick = NO;

        NSLog(@"[TextPopupWindow] Initialized as non-activating panel with text (length: %lu): %@...",
              (unsigned long)[text length],
              [text substringToIndex:MIN((NSUInteger)50, [text length])]);

        // Add buttonClick message handler (in addition to bridge and consoleLog from base class)
        [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"buttonClick"];

        // Setup mouse tracking for the entire window
        [self setupMouseTracking];
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (NSString*)windowNameForLogging {
    return @"TextPopupWindow";
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Handle console messages from WebView
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[TextPopupWindow/JS/%@] %@", level, msg);
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

    // Handle buttonClick action (for new bridge system)
    if ([action isEqualToString:@"buttonClick"]) {
        NSDictionary* payload = message[@"payload"];
        NSString* btnAction = payload[@"action"];
        NSString* text = payload[@"text"];

        NSLog(@"[Bridge] Button click: %@ with text length: %lu", btnAction, (unsigned long)[text length]);

        // Set flag to prevent popup from closing during click processing
        self.isProcessingClick = YES;

        // Keep the popup open (cancel any scheduled hide)
        // TODO: Implement auto-hide scheduling for ButtonOverlayWindow
        // if (self.buttonWindow) {
        //     [self.buttonWindow cancelScheduledHide];
        // }

        // Handle copy action
        if ([btnAction isEqualToString:@"copy"] && text && [text length] > 0) {
            NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
            [pasteboard clearContents];
            [pasteboard setString:text forType:NSPasteboardTypeString];
            NSLog(@"[Bridge] Text copied to clipboard");
        }

        // Forward to the button window's observer with action details
        if (self.buttonWindow && self.buttonWindow.observer) {
            id observer = self.buttonWindow.observer;
            dispatch_async(dispatch_get_main_queue(), ^{
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [observer performSelector:@selector(handleButtonClickWithAction:text:) withObject:btnAction withObject:text];
                #pragma clang diagnostic pop
            });
        }

        // Reset the flag after a short delay to allow click to complete
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            self.isProcessingClick = NO;
            NSLog(@"[Bridge] Click processing complete");
        });

        // Send response back to JavaScript
        NSString* responseJS = [NSString stringWithFormat:@
            "window.__bridgeReceive({"
            "  id: '%@',"
            "  type: 'response',"
            "  action: 'buttonClick',"
            "  payload: {success: true}"
            "});",
            message[@"id"]];

        [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
            if (error) {
                NSLog(@"[Bridge] Error sending response: %@", error);
            }
        }];
    }
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)scriptMessage {
    // Override to handle both old and new message formats
    if ([scriptMessage.name isEqualToString:@"consoleLog"]) {
        if ([scriptMessage.body isKindOfClass:[NSDictionary class]]) {
            [self handleConsoleLog:scriptMessage.body];
        }
    } else if ([scriptMessage.name isEqualToString:@"bridge"]) {
        if ([scriptMessage.body isKindOfClass:[NSDictionary class]]) {
            [self handleBridgeMessage:scriptMessage.body];
        }
    } else if ([scriptMessage.name isEqualToString:@"buttonClick"]) {
        // Handle old-style buttonClick messages
        @try {
            if (![scriptMessage.body isKindOfClass:[NSDictionary class]]) {
                NSLog(@"[TextPopupWindow] ERROR: Invalid message body type");
                return;
            }

            // Set flag to prevent popup from closing during click processing
            self.isProcessingClick = YES;

            NSDictionary* data = (NSDictionary*)scriptMessage.body;
            NSString* action = data[@"action"];
            NSString* text = data[@"text"];

            if (!action) {
                NSLog(@"[TextPopupWindow] ERROR: No action in message");
                self.isProcessingClick = NO;
                return;
            }

            NSString* textPreview = @"";
            if (text && [text length] > 0) {
                NSUInteger previewLength = MIN((NSUInteger)50, [text length]);
                textPreview = [text substringToIndex:previewLength];
            }

            NSLog(@"[TextPopupWindow] Button clicked: %@ with text: %@", action, textPreview);

            // Keep the popup open (cancel any scheduled hide)
            // TODO: Implement auto-hide scheduling for ButtonOverlayWindow
            // if (self.buttonWindow) {
            //     [self.buttonWindow cancelScheduledHide];
            // }

            // Handle copy action
            if ([action isEqualToString:@"copy"] && text && [text length] > 0) {
                NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
                [pasteboard clearContents];
                [pasteboard setString:text forType:NSPasteboardTypeString];
                NSLog(@"[TextPopupWindow] Text copied to clipboard");
            }

            // Forward to the button window's observer with action details
            if (self.buttonWindow && self.buttonWindow.observer) {
                id observer = self.buttonWindow.observer;
                dispatch_async(dispatch_get_main_queue(), ^{
                    #pragma clang diagnostic push
                    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                    [observer performSelector:@selector(handleButtonClickWithAction:text:) withObject:action withObject:text];
                    #pragma clang diagnostic pop
                });
            }

            // Reset the flag after a short delay to allow click to complete
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                self.isProcessingClick = NO;
                NSLog(@"[TextPopupWindow] Click processing complete, popup can now be hidden");
            });
        } @catch (NSException *exception) {
            NSLog(@"[TextPopupWindow] ERROR handling button click: %@", exception.reason);
            self.isProcessingClick = NO;
        }
    }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    NSLog(@"[TextPopupWindow] Popup HTML loaded successfully");
    // Wait for React to initialize - try multiple times if needed
    __block int attemptCount = 0;
    __block __weak void (^weakTryUpdate)(void);
    void (^tryUpdate)(void);

    tryUpdate = ^{
        attemptCount++;
        NSLog(@"[TextPopupWindow] Attempting to update content (attempt %d)", attemptCount);

        if (self.currentText && [self.currentText length] > 0) {
            // First check if window.updateContent exists
            NSString* checkScript = @"typeof window.updateContent === 'function'";
            [self.webView evaluateJavaScript:checkScript completionHandler:^(id result, NSError *error) {
                BOOL functionExists = [result boolValue];
                NSLog(@"[TextPopupWindow] window.updateContent exists: %d", functionExists);

                if (functionExists) {
                    [self updateContentWithText:self.currentText];
                } else if (attemptCount < 5) {
                    // Try again after a short delay using weak reference
                    void (^strongTryUpdate)(void) = weakTryUpdate;
                    if (strongTryUpdate) {
                        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)),
                                     dispatch_get_main_queue(), strongTryUpdate);
                    }
                } else {
                    NSLog(@"[TextPopupWindow] ERROR: Failed to initialize after %d attempts", attemptCount);
                }
            }];
        }
    };
    weakTryUpdate = tryUpdate;

    // Initial attempt after 0.2 seconds
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), tryUpdate);
}

#pragma mark - Content Update

- (void)updateContentWithText:(NSString*)text {
    self.currentText = text;

    if (!text || [text length] == 0) {
        NSLog(@"[TextPopupWindow] updateContentWithText called with empty text");
        return;
    }

    NSLog(@"[TextPopupWindow] Updating content with text (length: %lu): %@...",
          (unsigned long)[text length],
          [text substringToIndex:MIN((NSUInteger)50, [text length])]);

    // Use JSON encoding for better escaping
    NSError* jsonError = nil;
    NSData* jsonData = [NSJSONSerialization dataWithJSONObject:@[text] options:0 error:&jsonError];
    if (jsonError || !jsonData) {
        NSLog(@"[TextPopupWindow] Error encoding text as JSON: %@", jsonError.localizedDescription);
        return;
    }

    NSString* jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];

    // Use new bridge format with fallback to old format
    NSString* js = [NSString stringWithFormat:@
        "try { "
        "  console.log('[Native->JS] Sending updateContent via bridge'); "
        "  if (window.__bridgeReceive) { "
        "    var textArray = %@; "
        "    window.__bridgeReceive({ "
        "      id: 'native-' + Date.now(), "
        "      from: 'native', "
        "      to: 'popup', "
        "      type: 'event', "
        "      action: 'updateContent', "
        "      payload: { "
        "        type: 'text', "
        "        text: textArray[0] "
        "      }, "
        "      timestamp: Date.now() "
        "    }); "
        "    console.log('[Native->JS] Bridge message sent successfully'); "
        "  } else if (window.updateContent) { "
        "    var textArray = %@; "
        "    window.updateContent(textArray[0]); "
        "    console.log('[Native->JS] Fallback to old updateContent'); "
        "  } else { "
        "    console.error('[Native->JS] Neither bridge nor updateContent found'); "
        "  } "
        "} catch (e) { "
        "  console.error('[Native->JS] Error sending message:', e); "
        "}", jsonString, jsonString];

    [self.webView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[TextPopupWindow] Error evaluating JavaScript: %@", error.localizedDescription);
        } else {
            NSLog(@"[TextPopupWindow] JavaScript executed successfully");
        }
    }];
}

#pragma mark - Mouse Tracking

- (void)setupMouseTracking {
    // Track mouse enter/exit and movement for the entire content view
    self.trackingArea = [[NSTrackingArea alloc] initWithRect:self.contentView.bounds
                                                     options:(NSTrackingMouseEnteredAndExited |
                                                              NSTrackingMouseMoved |
                                                              NSTrackingActiveAlways |
                                                              NSTrackingInVisibleRect)
                                                       owner:self
                                                    userInfo:nil];
    [self.contentView addTrackingArea:self.trackingArea];
    NSLog(@"[TextPopupWindow] Mouse tracking setup complete");
}

- (void)mouseEntered:(NSEvent *)event {
    NSLog(@"[TextPopupWindow] Mouse entered");
    // Mouse entered popup - cancel any pending hide from button
    // TODO: Implement auto-hide scheduling for ButtonOverlayWindow
    // if (self.buttonWindow) {
    //     [self.buttonWindow cancelScheduledHide];
    // }
}

- (void)mouseExited:(NSEvent *)event {
    NSLog(@"[TextPopupWindow] Mouse exited (isProcessingClick: %d)", self.isProcessingClick);

    // Don't hide if we're processing a button click
    if (self.isProcessingClick) {
        NSLog(@"[TextPopupWindow] Ignoring mouse exit during button click");
        return;
    }

    // Mouse left popup - schedule hide
    // TODO: Implement auto-hide scheduling for ButtonOverlayWindow
    // if (self.buttonWindow) {
    //     [self.buttonWindow scheduleHidePopup];
    // }
}

- (void)mouseDown:(NSEvent *)event {
    NSLog(@"[TextPopupWindow] Mouse down - keeping window open");
    // Handle mouse down to prevent window from closing
    // Cancel any scheduled hide
    // TODO: Implement auto-hide scheduling for ButtonOverlayWindow
    // if (self.buttonWindow) {
    //     [self.buttonWindow cancelScheduledHide];
    // }
}

- (void)mouseMoved:(NSEvent *)event {
    // Track mouse movement to keep window alive while mouse is inside
    // This prevents false mouse exit events
    // TODO: Implement auto-hide scheduling for ButtonOverlayWindow
    // [self.buttonWindow cancelScheduledHide];
}

#pragma mark - Focus Handling

- (BOOL)acceptsFirstResponder {
    return YES;
}

- (void)resignKeyWindow {
    // Don't let the window auto-hide when it resigns key status
    NSLog(@"[TextPopupWindow] resignKeyWindow called - keeping window visible");
    [super resignKeyWindow];
    // Explicitly cancel any scheduled hide
    // TODO: Implement auto-hide scheduling for ButtonOverlayWindow
    // if (self.buttonWindow) {
    //     [self.buttonWindow cancelScheduledHide];
    // }
}

#pragma mark - Cleanup

- (void)dealloc {
    // Remove buttonClick handler (bridge and consoleLog are handled by base class)
    if (self.webView) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.webView.configuration.userContentController removeScriptMessageHandlerForName:@"buttonClick"];
        });
    }

    // Base class handles webView and trackingArea cleanup
}

@end
