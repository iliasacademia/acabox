#import <WebKit/WebKit.h>

// AcceptingWebView: A WKWebView that accepts first mouse clicks
// Features:
// - Overrides acceptsFirstMouse to return YES
// - Allows clicks on web content without requiring window activation first
// - Fixes the double-click issue in non-activating panel windows
@interface AcceptingWebView : WKWebView

@end
