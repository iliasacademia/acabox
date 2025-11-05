#import "WebViewConfigHelper.h"
#import "ScriptInjector.h"
#import "DraggableAcceptingWebView.h"
#import <AppKit/AppKit.h>

@implementation WebViewConfigHelper

+ (WKWebView*)createWebViewWithFrame:(CGRect)frame
                      messageHandler:(id<WKScriptMessageHandler>)messageHandler
                 messageHandlerNames:(NSArray<NSString*>*)handlerNames
                       injectScripts:(BOOL)injectScripts {
    WKWebViewConfiguration* config = [self createConfigurationWithMessageHandler:messageHandler
                                                             messageHandlerNames:handlerNames
                                                                   injectScripts:injectScripts];

    WKWebView* webView = [[DraggableAcceptingWebView alloc] initWithFrame:frame configuration:config];
    webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    // Make WKWebView background transparent (for React to control styling)
    [webView setValue:@NO forKey:@"drawsBackground"];

    // Additional transparency settings for proper rounded corner display
    // Set the layer background to clear for true transparency at rounded corners
    webView.wantsLayer = YES;
    webView.layer.backgroundColor = [[NSColor clearColor] CGColor];

    return webView;
}

+ (WKWebViewConfiguration*)createConfigurationWithMessageHandler:(id<WKScriptMessageHandler>)messageHandler
                                             messageHandlerNames:(NSArray<NSString*>*)handlerNames
                                                   injectScripts:(BOOL)injectScripts {
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    config.preferences.javaScriptEnabled = YES;

    // Setup user content controller with message handlers
    WKUserContentController* userController = [[WKUserContentController alloc] init];

    // Register all requested message handlers
    for (NSString* handlerName in handlerNames) {
        [userController addScriptMessageHandler:messageHandler name:handlerName];
    }

    // Inject standard scripts if requested
    if (injectScripts) {
        // Console logging script
        NSString* consoleScript = [ScriptInjector consoleLoggingScript];
        WKUserScript* consoleUserScript = [[WKUserScript alloc] initWithSource:consoleScript
                                                                 injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                              forMainFrameOnly:YES];
        [userController addUserScript:consoleUserScript];

        // Bridge compatibility script
        NSString* bridgeScript = [ScriptInjector bridgeCompatibilityScript];
        NSLog(@"[WebViewConfigHelper] Bridge script length: %lu", (unsigned long)[bridgeScript length]);
        NSLog(@"[WebViewConfigHelper] Bridge script start: %@", [bridgeScript substringToIndex:MIN((NSUInteger)100, [bridgeScript length])]);
        WKUserScript* bridgeUserScript = [[WKUserScript alloc] initWithSource:bridgeScript
                                                                injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                             forMainFrameOnly:YES];
        [userController addUserScript:bridgeUserScript];
        NSLog(@"[WebViewConfigHelper] Bridge script added to userController");
    }

    config.userContentController = userController;
    return config;
}

@end
