#import "HTMLLoader.h"

@implementation HTMLLoader

+ (void)loadPopupHTMLIntoWebView:(WKWebView*)webView
                      windowName:(NSString*)windowName
                      globalPath:(NSString*)globalPath {
    NSArray<NSString*>* possiblePaths = [self possibleHTMLPathsWithGlobalPath:globalPath];

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
    NSMutableArray* possiblePaths = [NSMutableArray array];

    // Add custom path if set
    if (globalPath && [globalPath length] > 0) {
        [possiblePaths addObject:globalPath];
    }

    // Add default possible paths
    [possiblePaths addObjectsFromArray:@[
        // Development: dist/popup (relative to project root)
        [[[[NSBundle mainBundle].bundlePath stringByDeletingLastPathComponent] stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"dist/popup/index.html"],
        // Development: from .webpack output
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"popup/index.html"],
        // Packaged app
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"../popup/index.html"],
        // Alternative packaged
        [[[NSBundle mainBundle].bundlePath stringByAppendingPathComponent:@"Contents/Resources/popup"] stringByAppendingPathComponent:@"index.html"],
        // Alternative: popup in extraResources
        [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"../popup/index.html"]
    ]];

    return [possiblePaths copy];
}

@end
