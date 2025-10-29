#import "bridge.h"
#import <napi.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// Forward declaration
@class WordAccessibilityObserver;

// Forward declare to avoid circular dependency
@class ButtonOverlayWindow;
@class LineCountButtonWindow;

// Tooltip/Popup window for showing selected text on hover using React via WKWebView
// Use NSPanel for non-activating behavior - doesn't steal focus from MS Word
@interface TextPopupWindow : NSPanel <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate>
@property (nonatomic, strong) WKWebView* webView;
@property (nonatomic, strong) NSTrackingArea* trackingArea;
@property (nonatomic, weak) ButtonOverlayWindow* buttonWindow;
@property (nonatomic, strong) NSString* currentText;
@property (nonatomic, assign) BOOL isProcessingClick;
- (void)updateContentWithText:(NSString*)text;
@end

// Native button overlay window - Use NSPanel for non-activating behavior
@interface ButtonOverlayWindow : NSPanel
@property (nonatomic, weak) WordAccessibilityObserver* observer;
@property (nonatomic, strong) NSButton* button;
@property (nonatomic, strong) NSTrackingArea* trackingArea;
@property (nonatomic, strong) TextPopupWindow* popupWindow;
@property (nonatomic, strong) NSString* selectedText;
@property (nonatomic, copy) dispatch_block_t scheduledHideBlock;
@property (nonatomic, assign) CGRect selectionBounds;  // Store selection bounds for popup positioning
- (void)scheduleHidePopup;
- (void)cancelScheduledHide;
@end

// Click popup window - Non-activating panel for detailed information with React content
@interface ClickPopupWindow : NSPanel <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate>
@property (nonatomic, strong) WKWebView* webView;
@property (nonatomic, strong) NSString* currentData;
@property (nonatomic, assign) int count;
@property (nonatomic, strong) id globalMouseMonitor;
@property (nonatomic, weak) WordAccessibilityObserver* observer;
- (instancetype)initWithCount:(int)count observer:(WordAccessibilityObserver*)observer;
- (void)updateContentWithCount:(int)count;
- (void)loadPopupHTML;
- (void)startGlobalMouseMonitor;
- (void)stopGlobalMouseMonitor;
@end

// Line count button overlay window - Shows count on left of first line
@interface LineCountButtonWindow : NSPanel
@property (nonatomic, weak) WordAccessibilityObserver* observer;
@property (nonatomic, strong) NSTextField* countLabel;
@property (nonatomic, strong) NSTrackingArea* trackingArea;
@property (nonatomic, strong) NSPanel* hoverPopup;
@property (nonatomic, strong) ClickPopupWindow* clickPopup;
@property (nonatomic, copy) dispatch_block_t scheduledHideBlock;
@property (nonatomic, assign) int count;
- (void)updateCount:(int)count;
- (void)showHoverPopup;
- (void)hideHoverPopup;
- (void)showClickPopup;
- (void)hideClickPopup;
- (void)scheduleHidePopup;
- (void)cancelScheduledHide;
@end

// Global variable for popup path (declared at file scope for accessibility from both Obj-C and C++)
NSString* globalPopupPath = nil;

// Implementations

@implementation TextPopupWindow

- (instancetype)initWithText:(NSString*)text {
    // Fixed size for popup - will contain React UI with buttons
    CGFloat width = 380;
    CGFloat height = 220;

    self = [super initWithContentRect:NSMakeRect(0, 0, width, height)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];
    if (self) {
        self.backgroundColor = [NSColor clearColor];  // Transparent so React controls the background
        self.opaque = NO;
        self.level = NSFloatingWindowLevel + 1;  // Above the button
        self.hasShadow = NO;  // React will provide shadow via CSS
        self.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary;

        // CRITICAL: Make this panel non-activating so it doesn't steal focus from MS Word
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;  // Never become key window
        self.worksWhenModal = YES;  // Continue working even when modal dialogs are present
        self.hidesOnDeactivate = NO;  // Don't auto-hide when app deactivates

        // Enable mouse events for tracking
        self.ignoresMouseEvents = NO;
        self.acceptsMouseMovedEvents = YES;

        // Store the initial text
        self.currentText = text;
        self.isProcessingClick = NO;

        NSLog(@"[TextPopupWindow] Initialized as non-activating panel with text (length: %lu): %@...",
              (unsigned long)[text length],
              [text substringToIndex:MIN((NSUInteger)50, [text length])]);

        // Configure WKWebView
        WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
        config.preferences.javaScriptEnabled = YES;

        // Add message handlers
        WKUserContentController* userController = [[WKUserContentController alloc] init];
        [userController addScriptMessageHandler:self name:@"buttonClick"];
        [userController addScriptMessageHandler:self name:@"consoleLog"];
        [userController addScriptMessageHandler:self name:@"bridge"];  // NEW: For new bridge system

        // Inject console interceptor script
        NSString* consoleScript = @
            "const originalLog = console.log; "
            "const originalError = console.error; "
            "const originalWarn = console.warn; "
            "console.log = function(...args) { "
            "  originalLog.apply(console, args); "
            "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'log', message: args.join(' ')}); "
            "}; "
            "console.error = function(...args) { "
            "  originalError.apply(console, args); "
            "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'error', message: args.join(' ')}); "
            "}; "
            "console.warn = function(...args) { "
            "  originalWarn.apply(console, args); "
            "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'warn', message: args.join(' ')}); "
            "};";

        WKUserScript* script = [[WKUserScript alloc] initWithSource:consoleScript
                                                      injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                   forMainFrameOnly:YES];
        [userController addUserScript:script];

        // NEW: Inject bridge compatibility script
        NSString* bridgeScript = @
            "(function() {"
            "  console.log('[Bridge Compat] Injecting bridge functions');"
            "  window.__bridgeSend = function(msg) {"
            "    console.log('[Bridge Compat] Sending to native:', msg.action);"
            "    window.webkit.messageHandlers.bridge.postMessage(msg);"
            "  };"
            "  window.__bridgeReceive = function(msg) {"
            "    console.log('[Bridge Compat] Received from native:', msg.action);"
            "    if (window.__bridgeHandlers && window.__bridgeHandlers[msg.action]) {"
            "      window.__bridgeHandlers[msg.action](msg);"
            "    }"
            "  };"
            "  console.log('[Bridge Compat] Functions injected');"
            "})();";

        WKUserScript* bridgeCompat = [[WKUserScript alloc] initWithSource:bridgeScript
                                                           injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                        forMainFrameOnly:YES];
        [userController addUserScript:bridgeCompat];

        config.userContentController = userController;

        // Create WKWebView
        self.webView = [[WKWebView alloc] initWithFrame:self.contentView.bounds configuration:config];
        self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        self.webView.navigationDelegate = self;
        self.webView.UIDelegate = self;

        // Make WKWebView background transparent
        [self.webView setValue:@NO forKey:@"drawsBackground"];

        [self.contentView addSubview:self.webView];

        // Load the React popup HTML
        [self loadPopupHTML];

        // Setup mouse tracking for the entire window
        [self setupMouseTracking];
    }
    return self;
}

- (void)loadPopupHTML {
    // First check if a custom popup path was set from JavaScript
    // globalPopupPath is declared at file scope above
    NSMutableArray* possiblePaths = [NSMutableArray array];

    // Add custom path if set
    if (globalPopupPath && [globalPopupPath length] > 0) {
        [possiblePaths addObject:globalPopupPath];
    }

    // Add default possible paths
    [possiblePaths addObjectsFromArray:@[
        // Development: dist/popup (relative to project root)
        [[[[NSBundle mainBundle].bundlePath stringByDeletingLastPathComponent] stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"dist/popup/index.html"],
        // Development: from .webpack output
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"popup/index.html"],
        // Packaged app
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"../popup/index.html"],
        // Alternative packaged
        [[[NSBundle mainBundle].bundlePath stringByAppendingPathComponent:@"Contents/Resources/popup"] stringByAppendingPathComponent:@"index.html"],
        // Alternative: popup in extraResources
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"../popup/index.html"]
    ]];

    NSURL* popupURL = nil;
    for (NSString* path in possiblePaths) {
        if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
            popupURL = [NSURL fileURLWithPath:path];
            NSLog(@"[TextPopupWindow] Loading popup from: %@", path);
            break;
        }
    }

    if (popupURL) {
        NSURLRequest* request = [NSURLRequest requestWithURL:popupURL];
        [self.webView loadRequest:request];
    } else {
        NSLog(@"[TextPopupWindow] ERROR: Could not find popup HTML file!");
        NSLog(@"[TextPopupWindow] Tried paths:");
        for (NSString* path in possiblePaths) {
            NSLog(@"[TextPopupWindow]   - %@", path);
        }
    }
}

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
    // Extract just the text value from the JSON array [\"text\"] -> \"text\"

    // NEW: Use new bridge format
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

// WKNavigationDelegate - called when page finishes loading
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    NSLog(@"[TextPopupWindow] Popup HTML loaded successfully");
    // Wait for React to initialize - increase delay to ensure readiness
    // Try multiple times if needed to ensure content is updated
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

// WKScriptMessageHandler - receive messages from React
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.name isEqualToString:@"consoleLog"]) {
        // Handle console messages from WebView
        if ([message.body isKindOfClass:[NSDictionary class]]) {
            NSDictionary* data = (NSDictionary*)message.body;
            NSString* level = data[@"level"];
            NSString* msg = data[@"message"];
            NSLog(@"[TextPopupWindow/JS/%@] %@", level, msg);
        }
    } else if ([message.name isEqualToString:@"bridge"]) {
        // NEW: Handle new bridge system messages
        if (![message.body isKindOfClass:[NSDictionary class]]) {
            NSLog(@"[Bridge] ERROR: Invalid message body type");
            return;
        }

        NSDictionary* data = (NSDictionary*)message.body;
        NSString* action = data[@"action"];
        NSString* msgType = data[@"type"];

        NSLog(@"[Bridge] Received: action=%@, type=%@", action, msgType);

        // Handle bridge-ready signal
        if ([action isEqualToString:@"bridge-ready"]) {
            NSLog(@"[Bridge] JavaScript bridge is ready!");
            return;
        }

        // Handle buttonClick action (for compatibility)
        if ([action isEqualToString:@"buttonClick"]) {
            NSDictionary* payload = data[@"payload"];
            NSString* btnAction = payload[@"action"];
            NSString* text = payload[@"text"];

            NSLog(@"[Bridge] Button click: %@ with text length: %lu", btnAction, (unsigned long)[text length]);

            // Set flag to prevent popup from closing during click processing
            self.isProcessingClick = YES;

            // Keep the popup open (cancel any scheduled hide)
            if (self.buttonWindow) {
                [self.buttonWindow cancelScheduledHide];
            }

            // Handle copy action
            if ([btnAction isEqualToString:@"copy"] && text && [text length] > 0) {
                NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
                [pasteboard clearContents];
                [pasteboard setString:text forType:NSPasteboardTypeString];
                NSLog(@"[Bridge] Text copied to clipboard");
            }

            // Forward to the button window's observer with action details
            if (self.buttonWindow && self.buttonWindow.observer) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    [self.buttonWindow.observer handleButtonClickWithAction:btnAction text:text];
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
                data[@"id"]];

            [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
                if (error) {
                    NSLog(@"[Bridge] Error sending response: %@", error);
                }
            }];
        }
    } else if ([message.name isEqualToString:@"buttonClick"]) {
        @try {
            if (![message.body isKindOfClass:[NSDictionary class]]) {
                NSLog(@"[TextPopupWindow] ERROR: Invalid message body type");
                return;
            }

            // Set flag to prevent popup from closing during click processing
            self.isProcessingClick = YES;

            NSDictionary* data = (NSDictionary*)message.body;
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
            if (self.buttonWindow) {
                [self.buttonWindow cancelScheduledHide];
            }

            // Handle copy action
            if ([action isEqualToString:@"copy"] && text && [text length] > 0) {
                NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
                [pasteboard clearContents];
                [pasteboard setString:text forType:NSPasteboardTypeString];
                NSLog(@"[TextPopupWindow] Text copied to clipboard");
            }

            // Forward to the button window's observer with action details
            if (self.buttonWindow && self.buttonWindow.observer) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    [self.buttonWindow.observer handleButtonClickWithAction:action text:text];
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

- (void)setupMouseTracking {
    // Track mouse enter/exit for the entire content view
    // Use NSTrackingMouseMoved to get continuous updates
    // Use NSTrackingActiveAlways so tracking works even when window is not key
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
    if (self.buttonWindow) {
        [self.buttonWindow cancelScheduledHide];
    }
}

- (void)mouseExited:(NSEvent *)event {
    NSLog(@"[TextPopupWindow] Mouse exited (isProcessingClick: %d)", self.isProcessingClick);

    // Don't hide if we're processing a button click
    if (self.isProcessingClick) {
        NSLog(@"[TextPopupWindow] Ignoring mouse exit during button click");
        return;
    }

    // Mouse left popup - schedule hide
    if (self.buttonWindow) {
        [self.buttonWindow scheduleHidePopup];
    }
}

- (void)mouseDown:(NSEvent *)event {
    NSLog(@"[TextPopupWindow] Mouse down - keeping window open");
    // Handle mouse down to prevent window from closing
    // Cancel any scheduled hide
    if (self.buttonWindow) {
        [self.buttonWindow cancelScheduledHide];
    }
}

- (BOOL)canBecomeKeyWindow {
    // CRITICAL: Return NO to prevent stealing focus from MS Word
    // Panel will still receive mouse events due to NSWindowStyleMaskNonactivatingPanel
    return NO;
}

- (BOOL)canBecomeMainWindow {
    // CRITICAL: Return NO to prevent becoming the main window
    return NO;
}

- (BOOL)acceptsFirstResponder {
    return YES;
}

- (void)resignKeyWindow {
    // Don't let the window auto-hide when it resigns key status
    NSLog(@"[TextPopupWindow] resignKeyWindow called - keeping window visible");
    [super resignKeyWindow];
    // Explicitly cancel any scheduled hide
    if (self.buttonWindow) {
        [self.buttonWindow cancelScheduledHide];
    }
}

- (void)mouseMoved:(NSEvent *)event {
    // Track mouse movement to keep window alive while mouse is inside
    // This prevents false mouse exit events
    [self.buttonWindow cancelScheduledHide];
}

- (void)dealloc {
    // Clean up WKWebView resources thoroughly to prevent zombie processes
    // Note: Cleanup must be done carefully to avoid deadlocks
    if (_webView) {
        WKWebView* webView = _webView;

        // Remove navigation delegate immediately (safe)
        webView.navigationDelegate = nil;

        // Async cleanup to avoid blocking/deadlocking the main thread
        // This is important when dealloc is called from within dispatch_sync
        dispatch_async(dispatch_get_main_queue(), ^{
            // Stop loading and remove message handlers
            [webView stopLoading];
            [webView.configuration.userContentController removeScriptMessageHandlerForName:@"buttonClick"];
            [webView.configuration.userContentController removeScriptMessageHandlerForName:@"consoleLog"];
        });

        _webView = nil;
    }

    if (_trackingArea) {
        [self.contentView removeTrackingArea:_trackingArea];
        _trackingArea = nil;
    }
}

@end

@implementation ClickPopupWindow

- (instancetype)initWithCount:(int)count observer:(WordAccessibilityObserver*)observer {
    // Fixed size for popup - will contain React UI
    CGFloat width = 500;
    CGFloat height = 400;

    self = [super initWithContentRect:NSMakeRect(0, 0, width, height)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];
    if (self) {
        self.count = count;
        self.observer = observer;
        self.backgroundColor = [NSColor clearColor];  // Transparent so React controls the background
        self.opaque = NO;
        self.level = NSFloatingWindowLevel + 2;  // Above the hover popup
        self.hasShadow = NO;  // React will provide shadow via CSS
        self.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary;

        // CRITICAL: Make this panel non-activating so it doesn't steal focus from MS Word
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;  // Never become key window
        self.hidesOnDeactivate = NO;  // Don't auto-hide when app deactivates

        // Enable mouse events for tracking
        self.ignoresMouseEvents = NO;
        self.acceptsMouseMovedEvents = YES;

        // Configure WKWebView
        WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
        config.preferences.javaScriptEnabled = YES;

        // Add message handlers
        WKUserContentController* userController = [[WKUserContentController alloc] init];
        [userController addScriptMessageHandler:self name:@"bridge"];
        [userController addScriptMessageHandler:self name:@"consoleLog"];

        // Inject console interceptor script
        NSString* consoleScript = @
            "const originalLog = console.log; "
            "const originalError = console.error; "
            "const originalWarn = console.warn; "
            "console.log = function(...args) { "
            "  originalLog.apply(console, args); "
            "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'log', message: args.join(' ')}); "
            "}; "
            "console.error = function(...args) { "
            "  originalError.apply(console, args); "
            "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'error', message: args.join(' ')}); "
            "}; "
            "console.warn = function(...args) { "
            "  originalWarn.apply(console, args); "
            "  window.webkit.messageHandlers.consoleLog.postMessage({level: 'warn', message: args.join(' ')}); "
            "};";

        WKUserScript* script = [[WKUserScript alloc] initWithSource:consoleScript
                                                      injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                   forMainFrameOnly:YES];
        [userController addUserScript:script];

        // Inject bridge compatibility script
        NSString* bridgeScript = @
            "(function() {"
            "  console.log('[Bridge Compat] Injecting bridge functions');"
            "  window.__bridgeSend = function(msg) {"
            "    console.log('[Bridge Compat] Sending to native:', msg.action);"
            "    window.webkit.messageHandlers.bridge.postMessage(msg);"
            "  };"
            "  window.__bridgeReceive = function(msg) {"
            "    console.log('[Bridge Compat] Received from native:', msg.action);"
            "    if (window.__bridgeHandlers && window.__bridgeHandlers[msg.action]) {"
            "      window.__bridgeHandlers[msg.action](msg);"
            "    }"
            "  };"
            "  console.log('[Bridge Compat] Functions injected');"
            "})();";

        WKUserScript* bridgeCompat = [[WKUserScript alloc] initWithSource:bridgeScript
                                                           injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                        forMainFrameOnly:YES];
        [userController addUserScript:bridgeCompat];

        config.userContentController = userController;

        // Create WKWebView
        self.webView = [[WKWebView alloc] initWithFrame:self.contentView.bounds configuration:config];
        self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        self.webView.navigationDelegate = self;
        self.webView.UIDelegate = self;

        // Make WKWebView background transparent
        [self.webView setValue:@NO forKey:@"drawsBackground"];

        [self.contentView addSubview:self.webView];

        // Load the React popup HTML
        [self loadPopupHTML];
    }
    return self;
}

- (void)loadPopupHTML {
    // Use the same paths as TextPopupWindow
    NSMutableArray* possiblePaths = [NSMutableArray array];

    // Add custom path if set
    if (globalPopupPath && [globalPopupPath length] > 0) {
        [possiblePaths addObject:globalPopupPath];
    }

    // Add default possible paths
    [possiblePaths addObjectsFromArray:@[
        // Development: dist/popup (relative to project root)
        [[[[NSBundle mainBundle].bundlePath stringByDeletingLastPathComponent] stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"dist/popup/index.html"],
        // Development: from .webpack output
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"popup/index.html"],
        // Packaged app
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"../popup/index.html"],
        // Alternative packaged
        [[[NSBundle mainBundle].bundlePath stringByAppendingPathComponent:@"Contents/Resources/popup"] stringByAppendingPathComponent:@"index.html"],
        // Alternative: popup in extraResources
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"../popup/index.html"]
    ]];

    NSURL* popupURL = nil;
    for (NSString* path in possiblePaths) {
        if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
            popupURL = [NSURL fileURLWithPath:path];
            break;
        }
    }

    if (popupURL) {
        NSURLRequest* request = [NSURLRequest requestWithURL:popupURL];
        [self.webView loadRequest:request];
    } else {
        NSLog(@"[ClickPopupWindow] ERROR: Could not find popup HTML file!");
        NSLog(@"[ClickPopupWindow] Tried paths:");
        for (NSString* path in possiblePaths) {
            NSLog(@"[ClickPopupWindow]   - %@", path);
        }
    }
}

- (void)updateContentWithCount:(int)count {
    self.count = count;

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

// WKNavigationDelegate - called when page finishes loading
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // Wait for React to initialize then send initial content
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self updateContentWithCount:self.count];
    });
}

// WKScriptMessageHandler - handle messages from JavaScript
- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.name isEqualToString:@"consoleLog"]) {
        // Handle console logs from WebView
        NSDictionary* body = message.body;
        NSString* level = body[@"level"];
        NSString* msg = body[@"message"];
        NSLog(@"[ClickPopupWindow WebView %@] %@", level, msg);
    } else if ([message.name isEqualToString:@"bridge"]) {
        // Handle bridge messages
        NSDictionary* msg = message.body;
        NSString* action = msg[@"action"];

        // Handle button clicks
        if ([action isEqualToString:@"buttonClick"]) {
            NSDictionary* payload = msg[@"payload"];
            NSString* btnAction = payload[@"action"];
            NSNumber* count = payload[@"count"];

            // Forward to observer which will send to main.ts
            if (self.observer) {
                if ([btnAction isEqualToString:@"seeMore"]) {
                    NSString* message = [NSString stringWithFormat:@"seeMore|count:%@", count];
                    [self.observer handleButtonClickWithAction:@"seeMore" text:message];
                } else if ([btnAction isEqualToString:@"dismiss"]) {
                    NSString* message = [NSString stringWithFormat:@"dismiss|count:%@", count];
                    [self.observer handleButtonClickWithAction:@"dismiss" text:message];
                    // Also hide the popup
                    [self orderOut:nil];
                    [self stopGlobalMouseMonitor];
                }
            }

            // Send response back to JavaScript
            NSString* responseJS = [NSString stringWithFormat:@
                "window.__bridgeReceive({"
                "  id: '%@',"
                "  type: 'response',"
                "  action: 'buttonClick',"
                "  payload: {success: true}"
                "});",
                msg[@"id"]];

            [self.webView evaluateJavaScript:responseJS completionHandler:^(id result, NSError *error) {
                if (error) {
                    NSLog(@"[ClickPopupWindow] Error sending response: %@", error);
                }
            }];
        } else if ([action isEqualToString:@"close"]) {
            [self orderOut:nil];
            [self stopGlobalMouseMonitor];
        }
    }
}

// WKUIDelegate methods
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)navigationAction windowFeatures:(WKWindowFeatures *)windowFeatures {
    return nil;
}

- (BOOL)canBecomeKeyWindow {
    // CRITICAL: Return NO to prevent stealing focus from MS Word
    // Panel will still receive mouse events due to NSWindowStyleMaskNonactivatingPanel
    return NO;
}

- (BOOL)canBecomeMainWindow {
    // CRITICAL: Return NO to prevent becoming the main window
    return NO;
}

- (void)startGlobalMouseMonitor {
    // Don't create multiple monitors
    if (self.globalMouseMonitor) {
        return;
    }

    // Create a weak reference to self to avoid retain cycles
    __weak ClickPopupWindow* weakSelf = self;

    self.globalMouseMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
                                                                      handler:^(NSEvent *event) {
        ClickPopupWindow* strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }

        // Get the click location in screen coordinates
        NSPoint clickLocation = [NSEvent mouseLocation];

        // Check if click is outside the popup window
        NSRect popupFrame = strongSelf.frame;
        if (!NSPointInRect(clickLocation, popupFrame)) {
            [strongSelf orderOut:nil];
            [strongSelf stopGlobalMouseMonitor];
        }
    }];
}

- (void)stopGlobalMouseMonitor {
    if (self.globalMouseMonitor) {
        [NSEvent removeMonitor:self.globalMouseMonitor];
        self.globalMouseMonitor = nil;
    }
}

- (void)dealloc {
    // Stop global mouse monitor
    [self stopGlobalMouseMonitor];

    // Clean up WKWebView resources
    if (_webView) {
        WKWebView* webView = _webView;
        webView.navigationDelegate = nil;

        dispatch_async(dispatch_get_main_queue(), ^{
            [webView stopLoading];
            [webView.configuration.userContentController removeScriptMessageHandlerForName:@"bridge"];
            [webView.configuration.userContentController removeScriptMessageHandlerForName:@"consoleLog"];
        });

        _webView = nil;
    }
}

@end

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
    __weak typeof(self) weakSelf = self;
    self.scheduledHideBlock = dispatch_block_create(DISPATCH_BLOCK_INHERIT_QOS_CLASS, ^{
        typeof(self) strongSelf = weakSelf;
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
        [self.observer handleButtonClick];
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

// ============================================
// LineCountButtonWindow Implementation
// ============================================

@implementation LineCountButtonWindow

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Create borderless, transparent panel - 24x24 for circular button
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

        // CRITICAL: Make panel non-activating so hovering doesn't steal focus
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;
        self.worksWhenModal = YES;
        self.hidesOnDeactivate = NO;

        // Generate random count (1-12, showing "9+" for 10+)
        self.count = 1 + (arc4random_uniform(12));

        // Create circular background view
        NSView* circleView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, buttonSize, buttonSize)];
        circleView.wantsLayer = YES;
        circleView.layer.backgroundColor = [[NSColor whiteColor] CGColor];
        circleView.layer.borderColor = [[NSColor blackColor] CGColor];
        circleView.layer.borderWidth = 1.0;  // 1px border
        circleView.layer.cornerRadius = buttonSize / 2;  // Make it circular
        [self.contentView addSubview:circleView];

        // Create label for number with proper vertical centering
        // NSTextField doesn't center vertically by default, so we need to adjust the frame
        CGFloat labelHeight = 14;  // Height for the text (adjusted for 10pt font in 24px button)
        CGFloat labelY = (buttonSize - labelHeight) / 2;  // Center vertically
        self.countLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(0, labelY, buttonSize, labelHeight)];
        self.countLabel.stringValue = self.count > 9 ? @"9+" : [NSString stringWithFormat:@"%d", self.count];
        self.countLabel.font = [NSFont boldSystemFontOfSize:10];
        self.countLabel.textColor = [NSColor blackColor];
        self.countLabel.backgroundColor = [NSColor clearColor];
        self.countLabel.bordered = NO;
        self.countLabel.editable = NO;
        self.countLabel.selectable = NO;
        self.countLabel.alignment = NSTextAlignmentCenter;
        self.countLabel.lineBreakMode = NSLineBreakByClipping;
        [self.contentView addSubview:self.countLabel];

        // Setup mouse tracking for hover
        [self setupMouseTracking];

        NSLog(@"[LineCountButton] Initialized with count: %d", self.count);
    }
    return self;
}

- (void)setupMouseTracking {
    NSLog(@"[LineCountButton] Setting up mouse tracking");
    NSLog(@"[LineCountButton] Content view bounds: x=%.1f y=%.1f w=%.1f h=%.1f",
          self.contentView.bounds.origin.x, self.contentView.bounds.origin.y,
          self.contentView.bounds.size.width, self.contentView.bounds.size.height);

    self.trackingArea = [[NSTrackingArea alloc] initWithRect:self.contentView.bounds
                                                     options:(NSTrackingMouseEnteredAndExited |
                                                              NSTrackingActiveAlways |
                                                              NSTrackingInVisibleRect)
                                                       owner:self
                                                    userInfo:nil];
    [self.contentView addTrackingArea:self.trackingArea];
    NSLog(@"[LineCountButton] Mouse tracking setup complete");
    NSLog(@"[LineCountButton] ignoresMouseEvents: %d", self.ignoresMouseEvents);
    NSLog(@"[LineCountButton] acceptsMouseMovedEvents: %d", self.acceptsMouseMovedEvents);
}

- (void)updateCount:(int)count {
    self.count = count;
    self.countLabel.stringValue = count > 9 ? @"9+" : [NSString stringWithFormat:@"%d", count];
}

- (void)mouseEntered:(NSEvent *)event {
    NSLog(@"[LineCountButton] Mouse entered");
    [self cancelScheduledHide];
    [self showHoverPopup];
}

- (void)mouseExited:(NSEvent *)event {
    NSLog(@"[LineCountButton] Mouse exited");
    [self scheduleHidePopup];
}

- (void)mouseDown:(NSEvent *)event {
    NSLog(@"[LineCountButton] ===== MOUSE DOWN EVENT RECEIVED =====");
    NSLog(@"[LineCountButton] Event type: %ld", (long)event.type);
    NSLog(@"[LineCountButton] Click count: %ld", (long)event.clickCount);
    NSLog(@"[LineCountButton] Button frame: x=%.1f y=%.1f w=%.1f h=%.1f",
          self.frame.origin.x, self.frame.origin.y, self.frame.size.width, self.frame.size.height);

    // Hide hover popup if showing
    NSLog(@"[LineCountButton] Hiding hover popup (if visible)...");
    [self hideHoverPopup];

    // Show the larger click popup
    NSLog(@"[LineCountButton] Calling showClickPopup...");
    [self showClickPopup];
    NSLog(@"[LineCountButton] ===== MOUSE DOWN HANDLING COMPLETE =====");
}

- (void)showHoverPopup {
    [self cancelScheduledHide];

    if (!self.hoverPopup) {
        // Create popup window
        CGFloat popupWidth = 220;
        CGFloat popupHeight = 100;

        self.hoverPopup = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, popupWidth, popupHeight)
                                                     styleMask:NSWindowStyleMaskBorderless
                                                       backing:NSBackingStoreBuffered
                                                         defer:NO];
        self.hoverPopup.backgroundColor = [NSColor whiteColor];
        self.hoverPopup.opaque = YES;
        self.hoverPopup.level = NSFloatingWindowLevel + 1;  // Above the button
        self.hoverPopup.hasShadow = YES;
        self.hoverPopup.floatingPanel = YES;
        self.hoverPopup.becomesKeyOnlyIfNeeded = NO;

        // Add border
        self.hoverPopup.contentView.wantsLayer = YES;
        self.hoverPopup.contentView.layer.borderColor = [[NSColor colorWithWhite:0.8 alpha:1.0] CGColor];
        self.hoverPopup.contentView.layer.borderWidth = 1.0;
        self.hoverPopup.contentView.layer.cornerRadius = 8.0;

        // Add title label
        NSTextField* titleLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(12, popupHeight - 35, popupWidth - 24, 20)];
        titleLabel.stringValue = @"Line Information";
        titleLabel.font = [NSFont boldSystemFontOfSize:13];
        titleLabel.textColor = [NSColor blackColor];
        titleLabel.backgroundColor = [NSColor clearColor];
        titleLabel.bordered = NO;
        titleLabel.editable = NO;
        titleLabel.selectable = NO;
        [self.hoverPopup.contentView addSubview:titleLabel];

        // Add count label
        NSTextField* countInfoLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(12, popupHeight - 60, popupWidth - 24, 20)];
        countInfoLabel.stringValue = [NSString stringWithFormat:@"Count: %d", self.count];
        countInfoLabel.font = [NSFont systemFontOfSize:12];
        countInfoLabel.textColor = [NSColor colorWithWhite:0.4 alpha:1.0];
        countInfoLabel.backgroundColor = [NSColor clearColor];
        countInfoLabel.bordered = NO;
        countInfoLabel.editable = NO;
        countInfoLabel.selectable = NO;
        [self.hoverPopup.contentView addSubview:countInfoLabel];

        // Add info label
        NSTextField* infoLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(12, popupHeight - 85, popupWidth - 24, 20)];
        infoLabel.stringValue = @"Click to view details";
        infoLabel.font = [NSFont systemFontOfSize:12];
        infoLabel.textColor = [NSColor colorWithWhite:0.4 alpha:1.0];
        infoLabel.backgroundColor = [NSColor clearColor];
        infoLabel.bordered = NO;
        infoLabel.editable = NO;
        infoLabel.selectable = NO;
        [self.hoverPopup.contentView addSubview:infoLabel];

        // Setup mouse tracking for popup
        NSTrackingArea* popupTracking = [[NSTrackingArea alloc]
            initWithRect:self.hoverPopup.contentView.bounds
                 options:(NSTrackingMouseEnteredAndExited |
                          NSTrackingActiveAlways |
                          NSTrackingInVisibleRect)
                   owner:self
                userInfo:nil];
        [self.hoverPopup.contentView addTrackingArea:popupTracking];
    }

    // Position popup to the right of button
    NSRect buttonFrame = self.frame;
    CGFloat popupX = buttonFrame.origin.x + buttonFrame.size.width + 8;
    CGFloat popupY = buttonFrame.origin.y;

    [self.hoverPopup setFrameOrigin:NSMakePoint(popupX, popupY)];
    [self.hoverPopup orderFrontRegardless];
    NSLog(@"[LineCountButton] Popup shown");
}

- (void)hideHoverPopup {
    [self cancelScheduledHide];
    if (self.hoverPopup) {
        [self.hoverPopup orderOut:nil];
        NSLog(@"[LineCountButton] Hover popup hidden");
    }
}

- (void)showClickPopup {
    if (!self.clickPopup) {
        // Create React-based popup window with current count and observer
        self.clickPopup = [[ClickPopupWindow alloc] initWithCount:self.count observer:self.observer];

        if (!self.clickPopup) {
            NSLog(@"[LineCountButton] ERROR: Failed to create ClickPopupWindow!");
            return;
        }
    } else {
        // Update content with current count
        [self.clickPopup updateContentWithCount:self.count];
    }

    // Position popup to the right of button, with top just below button
    NSRect buttonFrame = self.frame;
    CGFloat popupX = buttonFrame.origin.x + buttonFrame.size.width + 8;  // 8px to the right of button
    CGFloat popupY = buttonFrame.origin.y - 404;  // Top of popup 4px below button bottom (4 + 400 = 404)

    [self.clickPopup setFrameOrigin:NSMakePoint(popupX, popupY)];
    [self.clickPopup orderFrontRegardless];

    // Start monitoring for clicks outside the popup
    [self.clickPopup startGlobalMouseMonitor];
}

- (void)hideClickPopup {
    if (self.clickPopup) {
        [self.clickPopup stopGlobalMouseMonitor];
        [self.clickPopup orderOut:nil];
    }
}

- (void)scheduleHidePopup {
    [self cancelScheduledHide];

    __weak typeof(self) weakSelf = self;
    self.scheduledHideBlock = dispatch_block_create(DISPATCH_BLOCK_INHERIT_QOS_CLASS, ^{
        typeof(self) strongSelf = weakSelf;
        if (strongSelf) {
            [strongSelf hideHoverPopup];
            strongSelf.scheduledHideBlock = nil;
        }
    });

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(),
                   self.scheduledHideBlock);
}

- (void)cancelScheduledHide {
    if (self.scheduledHideBlock) {
        dispatch_block_cancel(self.scheduledHideBlock);
        self.scheduledHideBlock = nil;
    }
}

- (void)orderOut:(id)sender {
    NSLog(@"[LineCountButton] orderOut called");
    [self hideHoverPopup];
    // DON'T hide click popup when button is hidden - let it persist
    // [self hideClickPopup];  // COMMENTED OUT
    NSLog(@"[LineCountButton] Hiding hover popup but keeping click popup visible");
    [super orderOut:sender];
}

- (void)dealloc {
    [self hideHoverPopup];
    [self hideClickPopup];
    if (_hoverPopup) {
        [_hoverPopup close];
        _hoverPopup = nil;
    }
    if (_clickPopup) {
        [_clickPopup close];
        _clickPopup = nil;
    }
    if (_trackingArea) {
        [self.contentView removeTrackingArea:_trackingArea];
        _trackingArea = nil;
    }
}

- (BOOL)canBecomeKeyWindow {
    return NO;
}

- (BOOL)canBecomeMainWindow {
    return NO;
}

@end

// Callback function for accessibility events
static void AccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon);

@implementation WordAccessibilityObserver {
    AXObserverRef _observer;
    AXUIElementRef _wordApp;
    pid_t _pid;
    SelectionChangedCallback _selectionCallback;
    ScrollEventCallback _scrollCallback;
    ButtonClickCallback _buttonClickCallback;
    NSTimer* _scrollDebounceTimer;
    NSTimer* _positionMonitorTimer;
    NSTimer* _windowMoveDebounceTimer;  // Debounce timer for window move/resize
    BOOL _isScrolling;
    BOOL _isWindowMoving;  // Track if window is currently moving/resizing
    CGRect _lastSelectionBounds;
    BOOL _hasLastBounds;
    CGRect _lastFirstLinePosition;  // Track first line position for scroll detection
    BOOL _hasLastFirstLinePosition;
    id _scrollEventMonitor;  // Global scroll event monitor
    CGRect _cachedWordBounds;  // Cached Word window bounds for performance
    NSTimeInterval _lastBoundsUpdate;  // Timestamp of last bounds cache update
    ButtonOverlayWindow* _buttonWindow;
    LineCountButtonWindow* _lineCountButton;  // NEW: Line count button
    NSString* _currentSelectedText;
    id _appActivationObserver;
}

- (instancetype)initWithPID:(pid_t)pid {
    self = [super init];
    if (self) {
        _pid = pid;
        _wordApp = AXUIElementCreateApplication(pid);
        _observer = NULL;
        _isScrolling = NO;
        _isWindowMoving = NO;
        _lastSelectionBounds = CGRectZero;
        _hasLastBounds = NO;
        _lastFirstLinePosition = CGRectZero;
        _hasLastFirstLinePosition = NO;
        _scrollEventMonitor = nil;
        _cachedWordBounds = CGRectZero;
        _lastBoundsUpdate = 0;
    }
    return self;
}

- (void)dealloc {
    [self stopObserving];
    if (_wordApp) {
        CFRelease(_wordApp);
    }
}

- (BOOL)checkAccessibilityPermission {
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

- (BOOL)startObserving:(SelectionChangedCallback)selectionCallback
         scrollCallback:(ScrollEventCallback)scrollCallback
      buttonClickCallback:(ButtonClickCallback)buttonClickCallback
                  error:(NSError**)error {

    if (![self checkAccessibilityPermission]) {
        if (error) {
            *error = [NSError errorWithDomain:@"WordAccessibility"
                                        code:1
                                    userInfo:@{NSLocalizedDescriptionKey: @"Accessibility permission not granted"}];
        }
        return NO;
    }

    _selectionCallback = selectionCallback;
    _scrollCallback = scrollCallback;
    _buttonClickCallback = buttonClickCallback;

    // Create observer
    AXError result = AXObserverCreate(_pid, AccessibilityCallback, &_observer);
    if (result != kAXErrorSuccess) {
        if (error) {
            *error = [NSError errorWithDomain:@"WordAccessibility"
                                        code:result
                                    userInfo:@{NSLocalizedDescriptionKey: @"Failed to create AX observer"}];
        }
        return NO;
    }

    // DISABLED: Selection-based notifications (temporarily disabled for fixed button implementation)
    // AXObserverAddNotification(_observer, _wordApp, kAXSelectedTextChangedNotification, (__bridge void*)self);
    // AXObserverAddNotification(_observer, _wordApp, kAXValueChangedNotification, (__bridge void*)self);

    // Add window position/size notifications for instant button updates
    AXObserverAddNotification(_observer, _wordApp, kAXWindowMovedNotification, (__bridge void*)self);
    AXObserverAddNotification(_observer, _wordApp, kAXWindowResizedNotification, (__bridge void*)self);

    // Add observer to run loop
    CFRunLoopAddSource(CFRunLoopGetCurrent(),
                       AXObserverGetRunLoopSource(_observer),
                       kCFRunLoopDefaultMode);

    // Listen for app activation/deactivation to show/hide button automatically
    __weak typeof(self) weakSelf = self;
    _appActivationObserver = [[NSWorkspace sharedWorkspace].notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
        if (app.processIdentifier == strongSelf->_pid) {
            // MS Word came to foreground - show button
            [strongSelf startWordWindowTracking];
        } else {
            // Different app activated - hide button
            [strongSelf hideButton];
            // Stop position monitoring to save resources
            if (strongSelf->_positionMonitorTimer) {
                [strongSelf->_positionMonitorTimer invalidate];
                strongSelf->_positionMonitorTimer = nil;
            }
        }
    }];

    // Check if Word is currently the active application and show button immediately
    NSRunningApplication *activeApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (activeApp.processIdentifier == _pid) {
        [self startWordWindowTracking];
    }

    return YES;
}

- (void)stopObserving {
    // Stop all timers first (must be on main thread)
    dispatch_sync(dispatch_get_main_queue(), ^{
        if (self->_scrollDebounceTimer) {
            [self->_scrollDebounceTimer invalidate];
            self->_scrollDebounceTimer = nil;
        }

        if (self->_positionMonitorTimer) {
            [self->_positionMonitorTimer invalidate];
            self->_positionMonitorTimer = nil;
        }

        if (self->_windowMoveDebounceTimer) {
            [self->_windowMoveDebounceTimer invalidate];
            self->_windowMoveDebounceTimer = nil;
        }

        // Stop scroll event monitor
        [self stopScrollEventMonitor];

        // Hide and destroy button window synchronously
        if (self->_buttonWindow) {
            [self->_buttonWindow destroyPopup];  // Properly destroy the popup window
            [self->_buttonWindow orderOut:nil];
            [self->_buttonWindow close];
            self->_buttonWindow = nil;
        }

        // Hide and destroy line count button synchronously
        if (self->_lineCountButton) {
            [self->_lineCountButton hideHoverPopup];
            [self->_lineCountButton hideClickPopup];
            [self->_lineCountButton orderOut:nil];
            [self->_lineCountButton close];
            self->_lineCountButton = nil;
        }
    });

    // Remove app activation observer
    if (_appActivationObserver) {
        [[NSWorkspace sharedWorkspace].notificationCenter removeObserver:_appActivationObserver];
        _appActivationObserver = nil;
    }

    // Stop accessibility observer
    if (_observer) {
        // DISABLED: Selection-based notifications (temporarily disabled)
        // AXObserverRemoveNotification(_observer, _wordApp, kAXSelectedTextChangedNotification);
        // AXObserverRemoveNotification(_observer, _wordApp, kAXValueChangedNotification);

        // Remove window move/resize notifications
        AXObserverRemoveNotification(_observer, _wordApp, kAXWindowMovedNotification);
        AXObserverRemoveNotification(_observer, _wordApp, kAXWindowResizedNotification);

        CFRunLoopRemoveSource(CFRunLoopGetCurrent(),
                             AXObserverGetRunLoopSource(_observer),
                             kCFRunLoopDefaultMode);
        CFRelease(_observer);
        _observer = NULL;
    }

    // Clear state
    _hasLastBounds = NO;
    _isScrolling = NO;
    _isWindowMoving = NO;
    _currentSelectedText = nil;
}

- (void)showButtonAtPosition:(CGRect)bounds withText:(NSString*)text {
    dispatch_async(dispatch_get_main_queue(), ^{
        // Store current selection
        self->_currentSelectedText = text;

        // Create button window if it doesn't exist
        if (!self->_buttonWindow) {
            self->_buttonWindow = [[ButtonOverlayWindow alloc] initWithObserver:self];
        }

        // Update the selected text for hover popup
        [self->_buttonWindow setSelectedText:text];

        // Store selection bounds for popup positioning
        self->_buttonWindow.selectionBounds = bounds;

        // Get the document's left margin
        CGFloat leftMargin = [self getDocumentLeftMargin];

        // Position button to the left of the document margin
        CGFloat buttonWidth = 10;  // Current button width
        CGFloat buttonPadding = 15;  // Space between button and margin
        CGFloat buttonX;

        if (leftMargin > 0) {
            // Use document left margin
            buttonX = leftMargin + buttonPadding;
        } else {
            // Fallback: position to left of selection
            buttonX = bounds.origin.x - buttonWidth - buttonPadding;
        }

        CGPoint buttonPosition = CGPointMake(buttonX, bounds.origin.y);
        [self->_buttonWindow positionAtPoint:buttonPosition withHeight:bounds.size.height];

        // Show the button without activating (non-activating panel)
        [self->_buttonWindow orderFrontRegardless];
    });
}

- (void)hideButton {
    // Execute synchronously for immediate hiding (called from main thread via NSEvent handler)
    if (_buttonWindow) {
        [_buttonWindow orderOut:nil];
    }
    if (_lineCountButton) {
        [_lineCountButton hideHoverPopup];
        // Hide click popup when Word loses focus
        [_lineCountButton hideClickPopup];
        [_lineCountButton orderOut:nil];
    }
}

- (void)showFixedButton {
    dispatch_async(dispatch_get_main_queue(), ^{
        // Create button window if it doesn't exist
        if (!self->_buttonWindow) {
            self->_buttonWindow = [[ButtonOverlayWindow alloc] initWithObserver:self];
        }

        // Get Word window bounds
        CGRect wordBounds = [self getWordWindowBounds];
        if (CGRectIsEmpty(wordBounds)) {
            return;
        }

        // Position to the right of Grammarly button
        // Grammarly button is typically ~40-50px from left edge and ~40px wide
        CGFloat bottomPadding = 40.0;  // Match Grammarly's vertical position
        CGFloat leftOffset = 45.0;  // Position to the right of Grammarly button
        CGFloat buttonSize = 24.0;

        // Get primary screen height for coordinate conversion
        NSScreen* primaryScreen = [NSScreen screens][0];
        CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

        // Word bounds are in top-left coordinate system (from Accessibility API)
        // Convert to Cocoa coordinates (bottom-left origin)
        CGFloat windowBottom = primaryScreenHeight - (wordBounds.origin.y + wordBounds.size.height);

        // Position button to the right of Grammarly button at bottom
        CGFloat buttonX = wordBounds.origin.x + leftOffset;
        CGFloat buttonY = windowBottom + bottomPadding;

        // Position the button window
        NSRect buttonFrame = NSMakeRect(buttonX, buttonY, buttonSize, buttonSize);
        [self->_buttonWindow setFrame:buttonFrame display:YES];

        // Show the button without activating (non-activating panel)
        [self->_buttonWindow orderFrontRegardless];

        // Also show line count button
        [self showLineCountButton];
    });
}

- (void)showLineCountButton {
    // Must be called from main queue
    dispatch_async(dispatch_get_main_queue(), ^{
        // Create line count button if it doesn't exist
        if (!self->_lineCountButton) {
            self->_lineCountButton = [[LineCountButtonWindow alloc] initWithObserver:self];
        }

        // Get Word window bounds and text area info
        CGRect wordBounds = [self getWordWindowBounds];
        if (CGRectIsEmpty(wordBounds)) {
            NSLog(@"[LineCountButton] Cannot show - Word window bounds unavailable");
            return;
        }

        // Get the position of the first line using Accessibility API
        CGRect firstLineBounds = [self getFirstLinePosition];

        CGFloat buttonSize = 24.0;
        CGFloat buttonX, buttonY;

        if (!CGRectIsEmpty(firstLineBounds)) {
            // Successfully got first line position - position button to the left of it
            CGFloat leftMargin = 60.0;  // 60px margin from left edge of first character
            buttonX = firstLineBounds.origin.x - buttonSize - leftMargin;

            // Convert from top-left origin (Accessibility API) to bottom-left origin (Cocoa)
            NSScreen* primaryScreen = [NSScreen screens][0];
            CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

            // Convert Y coordinate: bottom-left Y = screenHeight - topLeft Y - height
            CGFloat cocoaY = primaryScreenHeight - firstLineBounds.origin.y - firstLineBounds.size.height;

            // Center button vertically with the first line
            buttonY = cocoaY + (firstLineBounds.size.height - buttonSize) / 2;
        } else {
            // Fallback to fixed positioning if we can't get first line
            CGFloat topPadding = 150.0;
            CGFloat leftPadding = 50.0;

            // Get primary screen height for coordinate conversion
            NSScreen* primaryScreen = [NSScreen screens][0];
            CGFloat primaryScreenHeight = primaryScreen.frame.size.height;
            CGFloat windowTop = primaryScreenHeight - wordBounds.origin.y;

            buttonX = wordBounds.origin.x + leftPadding;
            buttonY = windowTop - topPadding;
        }

        // Validate that button position is on-screen
        NSRect buttonFrame = NSMakeRect(buttonX, buttonY, buttonSize, buttonSize);

        // Check if button is within any visible screen bounds
        BOOL isOnScreen = NO;
        for (NSScreen* screen in [NSScreen screens]) {
            if (NSIntersectsRect(buttonFrame, screen.frame)) {
                isOnScreen = YES;
                break;
            }
        }

        if (!isOnScreen) {
            // Button would be off-screen, hide it instead
            [self->_lineCountButton orderOut:nil];
            return;
        }

        // Position the button window
        [self->_lineCountButton setFrame:buttonFrame display:YES];

        // Show the button without activating (non-activating panel)
        [self->_lineCountButton orderFrontRegardless];
    });
}

- (void)startWordWindowTracking {
    // Start scroll event monitor for immediate scroll detection
    [self startScrollEventMonitor];

    // Start position monitoring timer for fallback (keyboard scrolling, edge cases)
    [_positionMonitorTimer invalidate];
    _positionMonitorTimer = [NSTimer scheduledTimerWithTimeInterval:0.5  // Check every 500ms (fallback for edge cases)
                                                             repeats:YES
                                                               block:^(NSTimer * _Nonnull timer) {
        [self updateButtonPosition];
    }];

    // Show button immediately
    [self showFixedButton];
}

- (void)updateCachedWordBounds {
    _cachedWordBounds = [self getWordWindowBounds];
    _lastBoundsUpdate = [[NSDate date] timeIntervalSince1970];
}

- (void)startScrollEventMonitor {
    if (_scrollEventMonitor) {
        return;  // Already monitoring
    }

    // Initialize bounds cache
    [self updateCachedWordBounds];

    __weak WordAccessibilityObserver* weakSelf = self;

    _scrollEventMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                                                  handler:^(NSEvent *event) {
        WordAccessibilityObserver* strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }

        // Get mouse location in screen coordinates
        NSPoint mouseLocation = [NSEvent mouseLocation];

        // Refresh bounds cache if stale (older than 1 second)
        NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
        if (now - strongSelf->_lastBoundsUpdate > 1.0 || CGRectIsEmpty(strongSelf->_cachedWordBounds)) {
            [strongSelf updateCachedWordBounds];
        }

        // Check if mouse is within Word window bounds
        if (!CGRectIsEmpty(strongSelf->_cachedWordBounds) &&
            NSPointInRect(mouseLocation, strongSelf->_cachedWordBounds)) {
            // Mouse is over Word window - handle scroll event
            [strongSelf handleScrollEvent:event];
        }
    }];
}

- (void)handleScrollEvent:(NSEvent*)event {
    // Ignore momentum scrolling (only handle active user scrolling)
    if (event.momentumPhase != NSEventPhaseNone) {
        // During momentum phase, still debounce but don't trigger initial hide
        if (_isScrolling) {
            // Reset debounce timer during momentum
            [_scrollDebounceTimer invalidate];
            _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                                    repeats:NO
                                                                      block:^(NSTimer * _Nonnull timer) {
                self->_isScrolling = NO;
                [self showFixedButton];
            }];
        }
        return;
    }

    // Active scrolling detected
    if (!_isScrolling) {
        _isScrolling = YES;
        // Hide button and popup immediately
        [self hideButton];
    }

    // Debounce scroll end - reset timer on each scroll event
    [_scrollDebounceTimer invalidate];
    _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                            repeats:NO
                                                              block:^(NSTimer * _Nonnull timer) {
        self->_isScrolling = NO;
        // Show button at new position after scroll ends
        [self showFixedButton];
    }];
}

- (void)stopScrollEventMonitor {
    if (_scrollEventMonitor) {
        [NSEvent removeMonitor:_scrollEventMonitor];
        _scrollEventMonitor = nil;
    }
}

- (void)updateButtonPosition {
    if (!_buttonWindow) {
        return;
    }

    // Get current Word window bounds
    CGRect wordBounds = [self getWordWindowBounds];
    if (CGRectIsEmpty(wordBounds)) {
        // Word window not available, hide button
        [self hideButton];
        return;
    }

    // Get current first line position for scroll detection
    CGRect currentFirstLinePosition = [self getFirstLinePosition];

    // Check if first line position changed (indicates scrolling)
    if (_hasLastFirstLinePosition && !CGRectIsEmpty(currentFirstLinePosition)) {
        CGFloat tolerance = 1.0;  // 1px tolerance
        BOOL positionChanged = (fabs(currentFirstLinePosition.origin.y - _lastFirstLinePosition.origin.y) > tolerance);

        if (positionChanged) {
            // Position changed - user is scrolling
            if (!_isScrolling) {
                _isScrolling = YES;
                // Hide button and popup immediately on scroll start
                [self hideButton];
            }

            // Update stored position
            _lastFirstLinePosition = currentFirstLinePosition;

            // Debounce scroll end
            [_scrollDebounceTimer invalidate];
            _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                                    repeats:NO
                                                                      block:^(NSTimer * _Nonnull timer) {
                self->_isScrolling = NO;
                // Show button at new position after scroll ends
                [self showFixedButton];
            }];

            return;  // Don't update button position while scrolling
        }
    }

    // Store current position for next check
    if (!CGRectIsEmpty(currentFirstLinePosition)) {
        _lastFirstLinePosition = currentFirstLinePosition;
        _hasLastFirstLinePosition = YES;
    }

    // Update button position (only if not scrolling)
    if (!_isScrolling) {
        [self showFixedButton];
    }
}

- (void)handleWindowMoveOrResize {
    // Immediately hide button during window movement/resize
    if (!_isWindowMoving) {
        _isWindowMoving = YES;
        [self hideButton];
    }

    // Update cached Word bounds immediately when window moves
    [self updateCachedWordBounds];

    // Cancel any existing debounce timer
    if (_windowMoveDebounceTimer) {
        [_windowMoveDebounceTimer invalidate];
        _windowMoveDebounceTimer = nil;
    }

    // Start new debounce timer (500ms)
    __weak typeof(self) weakSelf = self;
    _windowMoveDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf) {
            // Window movement stopped for 500ms - show button at new position
            strongSelf->_isWindowMoving = NO;
            [strongSelf updateButtonPosition];
            strongSelf->_windowMoveDebounceTimer = nil;
        }
    }];
}

- (void)handleAppActivation {
    // When MS Word comes to foreground, delay slightly to allow the text editor to receive focus
    // before querying the accessibility API for selected text
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.15 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        NSDictionary* selection = [strongSelf getSelectedText];
        if (selection && [selection[@"text"] length] > 0) {
            NSString* text = selection[@"text"];
            CGRect bounds = CGRectMake(
                [selection[@"x"] doubleValue],
                [selection[@"y"] doubleValue],
                [selection[@"width"] doubleValue],
                [selection[@"height"] doubleValue]
            );

            // Update stored bounds
            strongSelf->_lastSelectionBounds = bounds;
            strongSelf->_hasLastBounds = YES;

            // Show the button at the current position
            [strongSelf showButtonAtPosition:bounds withText:text];

            // Always restart position monitoring to ensure it's running
            [strongSelf->_positionMonitorTimer invalidate];
            strongSelf->_positionMonitorTimer = [NSTimer scheduledTimerWithTimeInterval:0.05
                                                                                 repeats:YES
                                                                                   block:^(NSTimer * _Nonnull timer) {
                [strongSelf checkPositionChange];
            }];
        }
    });
}

- (void)handleButtonClick {
    // Also send callback to JavaScript for logging in main.ts
    if (_buttonClickCallback) {
        _buttonClickCallback("academia-button-clicked");
    }
}

- (void)handleButtonClickWithAction:(NSString*)action text:(NSString*)text {
    // Call back to JavaScript with action and text
    if (_buttonClickCallback && text && action) {
        // Format: "action|text" so JavaScript can parse it
        NSString* message = [NSString stringWithFormat:@"%@|%@", action, text];
        _buttonClickCallback([message UTF8String]);
    }
}

- (NSDictionary*)getSelectedText {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return nil;
    }

    // Get selected text
    CFTypeRef selectedText = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXSelectedTextAttribute, &selectedText);

    if (error != kAXErrorSuccess || !selectedText) {
        CFRelease(focusedElement);
        return nil;
    }

    NSString* text = (__bridge_transfer NSString*)selectedText;

    // Get selected text range
    CFTypeRef selectedRange = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXSelectedTextRangeAttribute, &selectedRange);

    CGRect bounds = CGRectZero;
    if (error == kAXErrorSuccess && selectedRange) {
        // Get bounds for the selected range
        CFTypeRef rangeValue = NULL;
        error = AXUIElementCopyParameterizedAttributeValue(focusedElement,
                                                           kAXBoundsForRangeParameterizedAttribute,
                                                           selectedRange,
                                                           &rangeValue);
        if (error == kAXErrorSuccess && rangeValue) {
            AXValueGetValue((AXValueRef)rangeValue, (AXValueType)kAXValueTypeCGRect, &bounds);
            CFRelease(rangeValue);
        }
        CFRelease(selectedRange);
    }

    CFRelease(focusedElement);

    return @{
        @"text": text ?: @"",
        @"x": @(bounds.origin.x),
        @"y": @(bounds.origin.y),
        @"width": @(bounds.size.width),
        @"height": @(bounds.size.height)
    };
}

- (CGFloat)getDocumentLeftMargin {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return 0;
    }

    // Get the position of the text area element
    CFTypeRef positionValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXPositionAttribute, &positionValue);

    CGPoint position = CGPointZero;
    if (error == kAXErrorSuccess && positionValue) {
        AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position);
        CFRelease(positionValue);
    }

    CFRelease(focusedElement);

    // Return the left edge (x coordinate) of the text area (the left margin)
    return position.x;
}

- (CGRect)getFirstLinePosition {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return CGRectZero;
    }

    // Create a range for the first character (location: 0, length: 1)
    CFRange range = CFRangeMake(0, 1);
    AXValueRef rangeValue = AXValueCreate(kAXValueTypeCFRange, &range);

    if (!rangeValue) {
        CFRelease(focusedElement);
        return CGRectZero;
    }

    // Get bounds for the first character
    CFTypeRef boundsValue = NULL;
    error = AXUIElementCopyParameterizedAttributeValue(focusedElement,
                                                       kAXBoundsForRangeParameterizedAttribute,
                                                       rangeValue,
                                                       &boundsValue);

    CGRect bounds = CGRectZero;
    if (error == kAXErrorSuccess && boundsValue) {
        AXValueGetValue((AXValueRef)boundsValue, (AXValueType)kAXValueTypeCGRect, &bounds);
        CFRelease(boundsValue);
    }

    CFRelease(rangeValue);
    CFRelease(focusedElement);

    return bounds;
}

- (CGRect)getWordWindowBounds {
    // Get the frontmost window of Word
    CFTypeRef windowsRef = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXWindowsAttribute, &windowsRef);

    if (error != kAXErrorSuccess || !windowsRef) {
        return CGRectZero;
    }

    CFArrayRef windows = (CFArrayRef)windowsRef;
    if (CFArrayGetCount(windows) == 0) {
        CFRelease(windowsRef);
        return CGRectZero;
    }

    // Get the first window (frontmost)
    AXUIElementRef frontWindow = (AXUIElementRef)CFArrayGetValueAtIndex(windows, 0);

    // Get window position
    CFTypeRef positionValue = NULL;
    error = AXUIElementCopyAttributeValue(frontWindow, kAXPositionAttribute, &positionValue);
    CGPoint position = CGPointZero;
    if (error == kAXErrorSuccess && positionValue) {
        AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position);
        CFRelease(positionValue);
    }

    // Get window size
    CFTypeRef sizeValue = NULL;
    error = AXUIElementCopyAttributeValue(frontWindow, kAXSizeAttribute, &sizeValue);
    CGSize size = CGSizeZero;
    if (error == kAXErrorSuccess && sizeValue) {
        AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size);
        CFRelease(sizeValue);
    }

    CFRelease(windowsRef);

    CGRect bounds = CGRectMake(position.x, position.y, size.width, size.height);

    return bounds;
}

- (void)checkPositionChange {
    if (!_hasLastBounds) {
        return;
    }

    NSDictionary* selection = [self getSelectedText];
    if (!selection || [selection[@"text"] length] == 0) {
        // Selection cleared, stop monitoring and hide button
        [_positionMonitorTimer invalidate];
        _positionMonitorTimer = nil;
        _hasLastBounds = NO;
        [self hideButton];
        return;
    }

    CGRect currentBounds = CGRectMake(
        [selection[@"x"] doubleValue],
        [selection[@"y"] doubleValue],
        [selection[@"width"] doubleValue],
        [selection[@"height"] doubleValue]
    );

    // Use very small tolerance for immediate detection
    CGFloat tolerance = 0.5;
    BOOL positionChanged = (fabs(currentBounds.origin.x - _lastSelectionBounds.origin.x) > tolerance ||
                           fabs(currentBounds.origin.y - _lastSelectionBounds.origin.y) > tolerance);

    if (positionChanged) {
        // Update stored bounds
        _lastSelectionBounds = currentBounds;

        if (!_isScrolling) {
            _isScrolling = YES;
            // Hide button immediately on scroll start
            [self hideButton];

            if (_scrollCallback) {
                _scrollCallback(YES);  // scrollStarted
            }
        }

        // Debounce scroll end
        [_scrollDebounceTimer invalidate];
        _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
            self->_isScrolling = NO;

            // Show button at new position after scroll ends
            NSString* text = selection[@"text"];
            [self showButtonAtPosition:currentBounds withText:text];

            if (self->_scrollCallback) {
                self->_scrollCallback(NO);  // scrollEnded
            }
        }];
    }
}

- (void)handleSelectionChanged {
    NSDictionary* selection = [self getSelectedText];
    if (selection && [selection[@"text"] length] > 0) {
        NSString* text = selection[@"text"];
        CGRect bounds = CGRectMake(
            [selection[@"x"] doubleValue],
            [selection[@"y"] doubleValue],
            [selection[@"width"] doubleValue],
            [selection[@"height"] doubleValue]
        );

        // Store the bounds for scroll detection
        _lastSelectionBounds = bounds;
        _hasLastBounds = YES;

        // Show native button immediately (no IPC delay!)
        [self showButtonAtPosition:bounds withText:text];

        // Start periodic position monitoring for immediate scroll detection
        [_positionMonitorTimer invalidate];
        _positionMonitorTimer = [NSTimer scheduledTimerWithTimeInterval:0.05  // Check every 50ms
                                                                 repeats:YES
                                                                   block:^(NSTimer * _Nonnull timer) {
            [self checkPositionChange];
        }];

        // Still notify JS about selection (for main window update)
        if (_selectionCallback) {
            _selectionCallback([text UTF8String], bounds);
        }
    }
}

- (void)handleValueChanged {
    // Detect scrolling by checking if selected text position changed
    if (!_hasLastBounds) {
        return;
    }

    NSDictionary* selection = [self getSelectedText];
    if (!selection || [selection[@"text"] length] == 0) {
        return;
    }

    CGRect currentBounds = CGRectMake(
        [selection[@"x"] doubleValue],
        [selection[@"y"] doubleValue],
        [selection[@"width"] doubleValue],
        [selection[@"height"] doubleValue]
    );

    // Check if position has changed (indicating scroll)
    // Allow small tolerance for floating point comparison
    CGFloat tolerance = 1.0;
    BOOL positionChanged = (fabs(currentBounds.origin.x - _lastSelectionBounds.origin.x) > tolerance ||
                           fabs(currentBounds.origin.y - _lastSelectionBounds.origin.y) > tolerance);

    if (positionChanged) {
        // Update stored bounds
        _lastSelectionBounds = currentBounds;

        if (!_isScrolling) {
            _isScrolling = YES;
            if (_scrollCallback) {
                _scrollCallback(YES);  // scrollStarted
            }
        }

        // Debounce scroll end
        [_scrollDebounceTimer invalidate];
        _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
            self->_isScrolling = NO;
            if (self->_scrollCallback) {
                self->_scrollCallback(NO);  // scrollEnded
            }
        }];
    }
}

@end

// Accessibility callback function
static void AccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon) {
    @autoreleasepool {
        WordAccessibilityObserver* self = (__bridge WordAccessibilityObserver*)refcon;

        NSString* notificationName = (__bridge NSString*)notification;

        if ([notificationName isEqualToString:(__bridge NSString*)kAXSelectedTextChangedNotification]) {
            [self handleSelectionChanged];
        } else if ([notificationName isEqualToString:(__bridge NSString*)kAXValueChangedNotification]) {
            [self handleValueChanged];
        } else if ([notificationName isEqualToString:(__bridge NSString*)kAXWindowMovedNotification]) {
            // Window moved - hide button and debounce
            [self handleWindowMoveOrResize];
        } else if ([notificationName isEqualToString:(__bridge NSString*)kAXWindowResizedNotification]) {
            // Window resized - hide button and debounce
            [self handleWindowMoveOrResize];
        }
    }
}

// Node-API bindings
namespace {

struct CallbackData {
    Napi::ThreadSafeFunction selectionTsfn;
    Napi::ThreadSafeFunction scrollTsfn;
    Napi::ThreadSafeFunction buttonClickTsfn;
};

WordAccessibilityObserver* globalObserver = nil;
CallbackData* globalCallbackData = nullptr;

void SelectionChangedCallbackBridge(const char* text, CGRect bounds) {
    if (globalCallbackData && globalCallbackData->selectionTsfn) {
        auto callback = [text = std::string(text), bounds](Napi::Env env, Napi::Function jsCallback) {
            Napi::Object event = Napi::Object::New(env);
            event.Set("type", "selectionChanged");
            event.Set("text", text);
            event.Set("x", bounds.origin.x);
            event.Set("y", bounds.origin.y);
            event.Set("width", bounds.size.width);
            event.Set("height", bounds.size.height);
            jsCallback.Call({event});
        };
        globalCallbackData->selectionTsfn.BlockingCall(callback);
    }
}

void ScrollEventCallbackBridge(bool isScrolling) {
    if (globalCallbackData && globalCallbackData->scrollTsfn) {
        auto callback = [isScrolling](Napi::Env env, Napi::Function jsCallback) {
            Napi::Object event = Napi::Object::New(env);
            event.Set("type", isScrolling ? "scrollStarted" : "scrollEnded");
            jsCallback.Call({event});
        };
        globalCallbackData->scrollTsfn.BlockingCall(callback);
    }
}

void ButtonClickCallbackBridge(const char* text) {
    if (globalCallbackData && globalCallbackData->buttonClickTsfn) {
        auto callback = [text = std::string(text)](Napi::Env env, Napi::Function jsCallback) {
            Napi::Object event = Napi::Object::New(env);
            event.Set("type", "buttonClicked");
            event.Set("text", text);
            jsCallback.Call({event});
        };
        globalCallbackData->buttonClickTsfn.BlockingCall(callback);
    }
}

Napi::Value StartObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (pid: number, callback: function)").ThrowAsJavaScriptException();
        return env.Null();
    }

    int32_t pid = info[0].As<Napi::Number>().Int32Value();
    Napi::Function callback = info[1].As<Napi::Function>();

    // Create thread-safe functions
    if (globalCallbackData) {
        delete globalCallbackData;
    }
    globalCallbackData = new CallbackData{
        Napi::ThreadSafeFunction::New(env, callback, "SelectionCallback", 0, 1),
        Napi::ThreadSafeFunction::New(env, callback, "ScrollCallback", 0, 1),
        Napi::ThreadSafeFunction::New(env, callback, "ButtonClickCallback", 0, 1)
    };

    // Create observer
    if (globalObserver) {
        [globalObserver stopObserving];
        globalObserver = nil;
    }

    globalObserver = [[WordAccessibilityObserver alloc] initWithPID:pid];

    NSError* error = nil;
    BOOL success = [globalObserver startObserving:SelectionChangedCallbackBridge
                                    scrollCallback:ScrollEventCallbackBridge
                                 buttonClickCallback:ButtonClickCallbackBridge
                                            error:&error];

    if (!success) {
        Napi::Error::New(env, error.localizedDescription.UTF8String).ThrowAsJavaScriptException();
        return env.Null();
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value StopObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (globalObserver) {
        [globalObserver stopObserving];
        globalObserver = nil;
    }

    if (globalCallbackData) {
        globalCallbackData->selectionTsfn.Release();
        globalCallbackData->scrollTsfn.Release();
        globalCallbackData->buttonClickTsfn.Release();
        delete globalCallbackData;
        globalCallbackData = nullptr;
    }

    return env.Null();
}

Napi::Value GetSelectedText(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    NSDictionary* selection = [globalObserver getSelectedText];
    if (!selection) {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("text", Napi::String::New(env, [selection[@"text"] UTF8String]));
    result.Set("x", Napi::Number::New(env, [selection[@"x"] doubleValue]));
    result.Set("y", Napi::Number::New(env, [selection[@"y"] doubleValue]));
    result.Set("width", Napi::Number::New(env, [selection[@"width"] doubleValue]));
    result.Set("height", Napi::Number::New(env, [selection[@"height"] doubleValue]));

    return result;
}

Napi::Value CheckPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
    BOOL hasPermission = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);

    return Napi::Boolean::New(env, hasPermission);
}

Napi::Value SetPopupPath(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected (path: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string pathStr = info[0].As<Napi::String>().Utf8Value();
    // globalPopupPath is accessible here because it's declared at file scope
    ::globalPopupPath = [NSString stringWithUTF8String:pathStr.c_str()];

    NSLog(@"[Native] Popup path set to: %@", ::globalPopupPath);

    return Napi::Boolean::New(env, true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startObserving", Napi::Function::New(env, StartObserving));
    exports.Set("stopObserving", Napi::Function::New(env, StopObserving));
    exports.Set("getSelectedText", Napi::Function::New(env, GetSelectedText));
    exports.Set("checkPermission", Napi::Function::New(env, CheckPermission));
    exports.Set("setPopupPath", Napi::Function::New(env, SetPopupPath));
    return exports;
}

} // namespace

NODE_API_MODULE(word_accessibility, Init)
