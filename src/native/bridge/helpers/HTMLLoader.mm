#import "HTMLLoader.h"

// External references to global variables (defined in bridge.mm)
// Use weak linkage so this can work in tests without bridge.mm
extern NSString* globalServerBaseUrl __attribute__((weak));
extern NSString* globalAuthToken __attribute__((weak));

// Define weak defaults if not defined elsewhere (for standalone compilation)
NSString* globalServerBaseUrl __attribute__((weak)) = nil;
NSString* globalAuthToken __attribute__((weak)) = nil;

@implementation HTMLLoader

+ (void)loadPopupHTMLIntoWebView:(WKWebView*)webView
                      windowName:(NSString*)windowName
                      globalPath:(NSString*)globalPath {
    [self loadPopupHTMLIntoWebView:webView windowName:windowName globalPath:globalPath subpath:nil];
}

+ (void)loadPopupHTMLIntoWebView:(WKWebView*)webView
                      windowName:(NSString*)windowName
                      globalPath:(NSString*)globalPath
                         subpath:(NSString*)subpath {
    // Forward to the queryParams version with nil
    [self loadPopupHTMLIntoWebView:webView
                        windowName:windowName
                        globalPath:globalPath
                           subpath:subpath
                       queryParams:nil];
}

+ (void)loadPopupHTMLIntoWebView:(WKWebView*)webView
                      windowName:(NSString*)windowName
                      globalPath:(NSString*)globalPath
                         subpath:(NSString*)subpath
                     queryParams:(NSDictionary<NSString*, NSString*>*)queryParams {
    // Load from HTTP server only (no file:// fallback for testing)
    if (globalServerBaseUrl && [globalServerBaseUrl length] > 0) {
        // Construct HTTP URL: http://127.0.0.1:{port}/ui/popup/{subpath}/
        NSString* urlPath = @"/ui/popup/";
        if (subpath && [subpath length] > 0) {
            urlPath = [urlPath stringByAppendingFormat:@"%@/", subpath];
        }

        NSString* fullUrlString = [globalServerBaseUrl stringByAppendingString:urlPath];

        // Build query parameters
        NSMutableArray* queryPairs = [NSMutableArray array];

        // Add auth token first if available
        if (globalAuthToken && [globalAuthToken length] > 0) {
            [queryPairs addObject:[NSString stringWithFormat:@"token=%@", globalAuthToken]];
        }

        // Append additional query parameters if provided
        if (queryParams && [queryParams count] > 0) {
            for (NSString* key in queryParams) {
                NSString* value = queryParams[key];
                // URL-encode the value
                NSString* encodedValue = [value stringByAddingPercentEncodingWithAllowedCharacters:[NSCharacterSet URLQueryAllowedCharacterSet]];
                [queryPairs addObject:[NSString stringWithFormat:@"%@=%@", key, encodedValue]];
            }
        }

        // Append query string if we have any parameters
        if ([queryPairs count] > 0) {
            fullUrlString = [fullUrlString stringByAppendingFormat:@"?%@", [queryPairs componentsJoinedByString:@"&"]];
        }

        NSURL* httpURL = [NSURL URLWithString:fullUrlString];

        if (httpURL) {
            NSLog(@"[%@] Loading popup from HTTP server: %@", windowName, fullUrlString);
            [webView loadRequest:[NSURLRequest requestWithURL:httpURL]];
            return;
        } else {
            NSLog(@"[%@] ERROR: Failed to construct HTTP URL from: %@", windowName, fullUrlString);
            return;
        }
    }

    NSLog(@"[%@] ERROR: HTTP server base URL not set! Cannot load popup without file:// fallback.", windowName);
}

+ (NSArray<NSString*>*)possibleHTMLPathsWithGlobalPath:(NSString*)globalPath {
    return [self possibleHTMLPathsWithGlobalPath:globalPath subpath:nil];
}

+ (NSArray<NSString*>*)possibleHTMLPathsWithGlobalPath:(NSString*)globalPath
                                                subpath:(NSString*)subpath {
    NSMutableArray* possiblePaths = [NSMutableArray array];

    // Construct subpath component (e.g., "academiaNotifications/" or "")
    NSString* subpathComponent = @"";
    if (subpath && [subpath length] > 0) {
        subpathComponent = [NSString stringWithFormat:@"%@/", subpath];
    }

    // Add custom path if set
    if (globalPath && [globalPath length] > 0) {
        if (subpath && [subpath length] > 0) {
            // If globalPath is a directory, append subpath/index.html
            // If globalPath is a file, replace last component with subpath/index.html
            NSString* basePath = [globalPath stringByDeletingLastPathComponent];
            [possiblePaths addObject:[basePath stringByAppendingPathComponent:[NSString stringWithFormat:@"%@index.html", subpathComponent]]];
        } else {
            [possiblePaths addObject:globalPath];
        }
    }

    // Add default possible paths with subpath support
    NSString* projectRoot = [[[[[NSBundle mainBundle].bundlePath
                                stringByDeletingLastPathComponent]  // Remove Electron.app
                                stringByDeletingLastPathComponent]  // Remove dist
                                stringByDeletingLastPathComponent]  // Remove electron
                                stringByDeletingLastPathComponent]; // Remove node_modules -> project root

    [possiblePaths addObjectsFromArray:@[
        // Development: dist/popup/[subpath]/ (relative to project root)
        [projectRoot stringByAppendingPathComponent:[NSString stringWithFormat:@"dist/popup/%@index.html", subpathComponent]],
        // Development: from .webpack output
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:[NSString stringWithFormat:@"popup/%@index.html", subpathComponent]],
        // Packaged app
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:[NSString stringWithFormat:@"../popup/%@index.html", subpathComponent]],
        // Alternative packaged
        [[[NSBundle mainBundle].bundlePath stringByAppendingPathComponent:@"Contents/Resources/popup"] stringByAppendingPathComponent:[NSString stringWithFormat:@"%@index.html", subpathComponent]],
        // Alternative: popup in extraResources
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:[NSString stringWithFormat:@"../popup/%@index.html", subpathComponent]]
    ]];

    return [possiblePaths copy];
}

@end
