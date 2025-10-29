#import "WebViewConfigHelper.h"
#import "ScriptInjector.h"

@implementation WebViewConfigHelper

+ (WKWebView*)createWebViewWithFrame:(CGRect)frame
                      messageHandler:(id<WKScriptMessageHandler>)messageHandler
                 messageHandlerNames:(NSArray<NSString*>*)handlerNames
                       injectScripts:(BOOL)injectScripts {
    WKWebViewConfiguration* config = [self createConfigurationWithMessageHandler:messageHandler
                                                             messageHandlerNames:handlerNames
                                                                   injectScripts:injectScripts];

    WKWebView* webView = [[WKWebView alloc] initWithFrame:frame configuration:config];
    webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    // Make WKWebView background transparent (for React to control styling)
    [webView setValue:@NO forKey:@"drawsBackground"];

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
        WKUserScript* bridgeUserScript = [[WKUserScript alloc] initWithSource:bridgeScript
                                                                injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                             forMainFrameOnly:YES];
        [userController addUserScript:bridgeUserScript];
    }

    config.userContentController = userController;
    return config;
}

@end
