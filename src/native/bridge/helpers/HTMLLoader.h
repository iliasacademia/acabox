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

// Returns array of possible HTML file paths to try
// @param globalPath Optional custom path (prepended if non-nil)
+ (NSArray<NSString*>*)possibleHTMLPathsWithGlobalPath:(NSString*)globalPath;

@end
