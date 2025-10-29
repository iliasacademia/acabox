#import "BasePopupWindow.h"
#import "../helpers/WebViewConfigHelper.h"
#import "../helpers/HTMLLoader.h"
#import "../helpers/PanelStyleHelper.h"

// External reference to global popup path (defined in bridge.mm)
extern NSString* globalPopupPath;

@implementation BasePopupWindow

- (instancetype)initWithSize:(CGSize)size
                windowLevel:(NSWindowLevel)level
                   observer:(WordAccessibilityObserver*)observer {
    self = [super initWithContentRect:NSMakeRect(0, 0, size.width, size.height)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];
    if (self) {
        self.observer = observer;

        // Configure panel style using helper
        [PanelStyleHelper configureAsNonActivatingPopup:self
                                           windowLevel:level
                                             hasShadow:NO
                                            isOpaque:NO];

        // Enable mouse events for tracking
        self.ignoresMouseEvents = NO;
        self.acceptsMouseMovedEvents = YES;

        // Create configured WKWebView using helper
        // Register standard message handlers: bridge, consoleLog
        self.webView = [WebViewConfigHelper createWebViewWithFrame:self.contentView.bounds
                                                    messageHandler:self
                                               messageHandlerNames:@[@"bridge", @"consoleLog"]
                                                     injectScripts:YES];

        // Set navigation and UI delegates
        self.webView.navigationDelegate = self;
        self.webView.UIDelegate = self;

        [self.contentView addSubview:self.webView];

        // Load HTML (subclass can override loadPopupHTML)
        [self loadPopupHTML];
    }
    return self;
}

#pragma mark - HTML Loading

- (void)loadPopupHTML {
    [HTMLLoader loadPopupHTMLIntoWebView:self.webView
                              windowName:[self windowNameForLogging]
                              globalPath:globalPopupPath];
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
    // CRITICAL: Return NO to prevent stealing focus from MS Word
    // Panel will still receive mouse events due to NSWindowStyleMaskNonactivatingPanel
    return NO;
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
