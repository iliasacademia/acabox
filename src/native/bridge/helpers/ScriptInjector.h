#import <Foundation/Foundation.h>

// ScriptInjector: Provides reusable JavaScript injection scripts for WKWebView
// Eliminates ~66 lines of duplication between TextPopupWindow and ClickPopupWindow
@interface ScriptInjector : NSObject

// Returns console logging interceptor script
// Forwards console.log/error/warn to native via consoleLog message handler
+ (NSString*)consoleLoggingScript;

// Returns bridge compatibility script
// Provides window.__bridgeSend and window.__bridgeReceive functions
+ (NSString*)bridgeCompatibilityScript;

@end
