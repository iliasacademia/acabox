#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

// HTMLLoader: Handles HTML file resolution and loading for WKWebView
// Eliminates ~88 lines of duplication between TextPopupWindow and ClickPopupWindow
@interface HTMLLoader : NSObject

// Loads popup HTML into the provided WKWebView
// Tries globalPopupPath first, then falls back to bundled paths
// @param webView The WKWebView to load HTML into
// @param windowName Name for logging (e.g., "TextPopupWindow")
// @param globalPath Optional custom path (pass nil to use default fallbacks)
+ (void)loadPopupHTMLIntoWebView:(WKWebView*)webView
                      windowName:(NSString*)windowName
                      globalPath:(NSString*)globalPath;

// Loads popup HTML with subpath support (e.g., "academiaNotifications" -> dist/popup/academiaNotifications/index.html)
// @param webView The WKWebView to load HTML into
// @param windowName Name for logging
// @param globalPath Optional custom base path
// @param subpath Subdirectory under the popup path (e.g., "academiaNotifications")
+ (void)loadPopupHTMLIntoWebView:(WKWebView*)webView
                      windowName:(NSString*)windowName
                      globalPath:(NSString*)globalPath
                         subpath:(NSString*)subpath;

// Loads popup HTML with subpath and query parameters support
// @param webView The WKWebView to load HTML into
// @param windowName Name for logging
// @param globalPath Optional custom base path
// @param subpath Subdirectory under the popup path (e.g., "academiaNotifications")
// @param queryParams Dictionary of query parameters to append to URL (e.g., @{@"pid": @"1234"})
+ (void)loadPopupHTMLIntoWebView:(WKWebView*)webView
                      windowName:(NSString*)windowName
                      globalPath:(NSString*)globalPath
                         subpath:(NSString*)subpath
                     queryParams:(NSDictionary<NSString*, NSString*>*)queryParams;

// Returns array of possible HTML file paths to try
// @param globalPath Optional custom path (prepended if non-nil)
+ (NSArray<NSString*>*)possibleHTMLPathsWithGlobalPath:(NSString*)globalPath;

// Returns array of possible HTML file paths with subpath support
// @param globalPath Optional custom base path
// @param subpath Subdirectory under the popup path
+ (NSArray<NSString*>*)possibleHTMLPathsWithGlobalPath:(NSString*)globalPath
                                                subpath:(NSString*)subpath;

@end
