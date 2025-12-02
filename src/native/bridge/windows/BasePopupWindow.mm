#import "BasePopupWindow.h"
#import "../helpers/WebViewConfigHelper.h"
#import "../helpers/HTMLLoader.h"
#import "../helpers/PanelStyleHelper.h"
#import "../views/DraggableAcceptingWebView.h"

// External reference to global popup path (defined in bridge.mm)
extern NSString* globalPopupPath;

@implementation BasePopupWindow

- (instancetype)initWithSize:(CGSize)size
                windowLevel:(NSWindowLevel)level
                   observer:(WordAccessibilityObserver*)observer {
    self = [super initWithContentRect:NSMakeRect(0, 0, size.width, size.height)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel | NSWindowStyleMaskResizable
                              backing:NSBackingStoreBuffered
                                defer:NO];
    if (self) {
        self.observer = observer;

        // Configure panel style using helper
        [PanelStyleHelper configureAsNonActivatingPopup:self
                                           windowLevel:level
                                             hasShadow:NO
                                            isOpaque:NO];

        // Set size constraints for resizable window
        [self setMinSize:NSMakeSize(300, 250)];
        [self setMaxSize:NSMakeSize(1000, 800)];

        // Enable mouse events for tracking
        self.ignoresMouseEvents = NO;
        self.acceptsMouseMovedEvents = YES;

        // Check if debug mode is enabled via DEBUG=1 environment variable
        NSString* debugEnv = [[[NSProcessInfo processInfo] environment] objectForKey:@"DEBUG"];
        BOOL isDebugMode = [debugEnv isEqualToString:@"1"];

        // Create configured WKWebView using helper
        // Register standard message handlers: bridge, consoleLog
        // Note: injectScripts:NO because HTMLLoader injects bridge script at runtime into HTML
        self.webView = [WebViewConfigHelper createWebViewWithFrame:self.contentView.bounds
                                                    messageHandler:self
                                               messageHandlerNames:@[@"bridge", @"consoleLog"]
                                                     injectScripts:NO
                                                   showDebugBorder:isDebugMode];

        // Set navigation and UI delegates
        self.webView.navigationDelegate = self;
        self.webView.UIDelegate = self;

        [self.contentView addSubview:self.webView];

        // Add debug border if webView is DraggableAcceptingWebView
        if ([self.webView isKindOfClass:[DraggableAcceptingWebView class]]) {
            DraggableAcceptingWebView* draggableWebView = (DraggableAcceptingWebView*)self.webView;
            NSView* debugBorder = [draggableWebView createDebugBorderView];
            if (debugBorder) {
                // Convert the border frame from WebView coordinates to contentView coordinates
                NSRect borderFrameInWebView = debugBorder.frame;
                NSRect borderFrameInContentView = [self.webView convertRect:borderFrameInWebView toView:self.contentView];
                debugBorder.frame = borderFrameInContentView;

                [self.contentView addSubview:debugBorder positioned:NSWindowAbove relativeTo:self.webView];
                NSLog(@"[BasePopupWindow] Added debug border view on top of webview at frame: (%.1f, %.1f, %.1f, %.1f)",
                      borderFrameInContentView.origin.x, borderFrameInContentView.origin.y,
                      borderFrameInContentView.size.width, borderFrameInContentView.size.height);
            }
        }

        // Load HTML (subclass can override loadPopupHTML)
        [self loadPopupHTML];
    }
    return self;
}

#pragma mark - HTML Loading

- (void)loadPopupHTML {
    [HTMLLoader loadPopupHTMLIntoWebView:self.webView
                              windowName:[self windowNameForLogging]
                              globalPath:globalPopupPath
                                 subpath:self.htmlSubpath
                             queryParams:self.queryParams];
}

- (NSString*)windowNameForLogging {
    // Subclasses should override to provide specific window name
    return @"BasePopupWindow";
}

#pragma mark - WKScriptMessageHandler

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.name isEqualToString:@"consoleLog"]) {
        [self handleConsoleLog:message.body];
    } else if ([message.name isEqualToString:@"bridge"]) {
        [self handleBridgeMessage:message.body];
    }
}

#pragma mark - Message Handling (Subclass Override)

- (void)handleBridgeMessage:(NSDictionary*)message {
    // Subclasses override to handle specific bridge messages
    NSLog(@"[%@] Received bridge message (not handled by base class): %@",
          [self windowNameForLogging], message[@"action"]);
}

- (void)handleConsoleLog:(NSDictionary*)logMessage {
    // Forward console logs to Xcode console
    NSString* level = logMessage[@"level"];
    NSString* msg = logMessage[@"message"];
    NSLog(@"[%@ WebView %@] %@", [self windowNameForLogging], level, msg);
}

#pragma mark - WKNavigationDelegate

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // Subclasses can override to perform actions after page load
}

#pragma mark - WKUIDelegate

- (WKWebView *)webView:(WKWebView *)webView
createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
   forNavigationAction:(WKNavigationAction *)navigationAction
        windowFeatures:(WKWindowFeatures *)windowFeatures {
    return nil;
}

#pragma mark - Focus Management

- (BOOL)canBecomeKeyWindow {
    // Allow window to become key to enable text input focus
    // This allows keyboard events to reach text inputs in the WebView
    return YES;
}

- (BOOL)canBecomeMainWindow {
    // CRITICAL: Return NO to prevent becoming the main window
    return NO;
}

#pragma mark - Cleanup

- (void)dealloc {
    // Clean up WKWebView resources
    if (_webView) {
        WKWebView* webView = _webView;
        webView.navigationDelegate = nil;
        webView.UIDelegate = nil;

        dispatch_async(dispatch_get_main_queue(), ^{
            [webView stopLoading];
            [webView.configuration.userContentController removeScriptMessageHandlerForName:@"bridge"];
            [webView.configuration.userContentController removeScriptMessageHandlerForName:@"consoleLog"];
        });

        _webView = nil;
    }
}

@end
