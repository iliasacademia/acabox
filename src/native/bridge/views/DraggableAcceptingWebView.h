#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>

// DraggableAcceptingWebView: A WKWebView that accepts first mouse clicks and enables window dragging
// Features:
// - Overrides acceptsFirstMouse to return YES
// - Allows clicks on web content without requiring window activation first
// - Fixes the double-click issue in non-activating panel windows
// - Enables window dragging from a configurable horizontal strip at the top
// - Uses native performWindowDragWithEvent: for proper macOS behavior
@interface DraggableAcceptingWebView : WKWebView

// Height of the draggable strip at the top (default: 60px)
@property (nonatomic) CGFloat dragHandleHeight;

// Left inset to avoid resize corner (default: 60px to avoid top-left resize edge)
@property (nonatomic) CGFloat dragHandleLeftInset;

// Right inset to avoid close button (default: 60px to avoid top-right content)
@property (nonatomic) CGFloat dragHandleRightInset;

// Show debug border around drag handle (default: YES)
@property (nonatomic) BOOL showDebugBorder;

// Create and return a debug border view (call this from parent to add as overlay)
- (NSView*)createDebugBorderView;

@end
