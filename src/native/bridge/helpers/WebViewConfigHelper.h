#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

// WebViewConfigHelper: Creates configured WKWebView instances with standard setup
// Eliminates ~130 lines of duplication between TextPopupWindow and ClickPopupWindow
@interface WebViewConfigHelper : NSObject

// Creates a fully configured WKWebView for popup windows
// @param frame The initial frame for the WebView
// @param messageHandler The object that will handle WKScriptMessageHandler messages
// @param messageHandlerNames Array of message handler names to register (e.g., @[@"bridge", @"consoleLog"])
// @param injectScripts If YES, injects console logging and bridge compatibility scripts
// @return Configured WKWebView instance
+ (WKWebView*)createWebViewWithFrame:(CGRect)frame
                      messageHandler:(id<WKScriptMessageHandler>)messageHandler
                 messageHandlerNames:(NSArray<NSString*>*)handlerNames
                       injectScripts:(BOOL)injectScripts;

// Creates a WKWebViewConfiguration with standard settings
// @param messageHandler The object that will handle WKScriptMessageHandler messages
// @param messageHandlerNames Array of message handler names to register
// @param injectScripts If YES, adds console and bridge user scripts
// @return Configured WKWebViewConfiguration instance
+ (WKWebViewConfiguration*)createConfigurationWithMessageHandler:(id<WKScriptMessageHandler>)messageHandler
                                             messageHandlerNames:(NSArray<NSString*>*)handlerNames
                                                   injectScripts:(BOOL)injectScripts;

@end
