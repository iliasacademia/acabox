#import "HTMLLoader.h"

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
    NSArray<NSString*>* possiblePaths = [self possibleHTMLPathsWithGlobalPath:globalPath subpath:subpath];

    NSURL* popupURL = nil;
    for (NSString* path in possiblePaths) {
        if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
            popupURL = [NSURL fileURLWithPath:path];
            NSLog(@"[%@] Loading popup from: %@", windowName, path);
            break;
        }
    }

    if (popupURL) {
        NSLog(@"[%@] Loading popup from: %@", windowName, popupURL.path);

        // Use loadFileURL:allowingReadAccessToURL: for proper file access
        NSURL* folderURL = [popupURL URLByDeletingLastPathComponent];
        [webView loadFileURL:popupURL allowingReadAccessToURL:folderURL];
    } else {
        NSLog(@"[%@] ERROR: Could not find popup HTML file!", windowName);
        NSLog(@"[%@] Tried paths:", windowName);
        for (NSString* path in possiblePaths) {
            NSLog(@"[%@]   - %@", windowName, path);
        }
    }
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
