#import "AcceptingWebView.h"

@implementation AcceptingWebView

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    // Allow clicks on web content without requiring window activation first
    // This fixes the double-click issue where users had to click once to focus
    // the window, then click again to actually trigger the button
    return YES;
}

@end
