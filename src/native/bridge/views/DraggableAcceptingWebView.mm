#import "DraggableAcceptingWebView.h"

@implementation DraggableAcceptingWebView {
    BOOL _isDraggingWindow;
    NSView* _debugBorderView;
}

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    self = [super initWithFrame:frame configuration:configuration];
    if (self) {
        // Default drag handle: horizontal strip at top, inset from corners
        _dragHandleHeight = 40.0;        // 40px tall strip
        _dragHandleLeftInset = 60.0;     // Avoid top-left resize corner
        _dragHandleRightInset = 60.0;    // Avoid top-right close button
        _isDraggingWindow = NO;
        _showDebugBorder = NO;           // Debug border disabled by default
    }
    return self;
}

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    // Allow clicks on web content without requiring window activation first
    // This fixes the double-click issue where users had to click once to focus
    // the window, then click again to actually trigger the button
    return YES;
}

- (void)mouseDown:(NSEvent *)event {
    // Always call super first to allow WebView to handle its own events
    [super mouseDown:event];

    // Get mouse location in view coordinates
    NSPoint locationInView = [self convertPoint:event.locationInWindow fromView:nil];
    CGFloat viewHeight = self.bounds.size.height;
    CGFloat viewWidth = self.bounds.size.width;

    // Check if click is in the draggable horizontal strip at TOP
    // NSWindow contentView uses flipped coordinates: Y=0 is at top, Y increases downward
    BOOL inDragHandleX = locationInView.x >= self.dragHandleLeftInset &&
                         locationInView.x <= (viewWidth - self.dragHandleRightInset);
    BOOL inDragHandleY = locationInView.y >= 0 && locationInView.y <= self.dragHandleHeight;

    if (inDragHandleX && inDragHandleY) {
        _isDraggingWindow = YES;
        NSLog(@"[DraggableAcceptingWebView] Mouse down in drag handle at (%.1f, %.1f), drag enabled",
              locationInView.x, locationInView.y);
    } else {
        _isDraggingWindow = NO;
        NSLog(@"[DraggableAcceptingWebView] Mouse down outside drag handle at (%.1f, %.1f), drag disabled",
              locationInView.x, locationInView.y);
    }
}

- (void)mouseDragged:(NSEvent *)event {
    // Always call super first to allow WebView to handle its own dragging
    [super mouseDragged:event];

    if (_isDraggingWindow) {
        // Use native API for proper macOS drag behavior
        // This handles menu bar avoidance, screen edge snapping, multi-monitor, etc.
        [self.window performWindowDragWithEvent:event];
    }
}

- (void)mouseUp:(NSEvent *)event {
    // Always call super first
    [super mouseUp:event];

    // Reset drag state
    if (_isDraggingWindow) {
        NSLog(@"[DraggableAcceptingWebView] Drag completed");
        _isDraggingWindow = NO;
    }
}

- (NSView*)createDebugBorderView {
    if (!self.showDebugBorder) {
        return nil;
    }

    // Calculate drag handle frame
    CGFloat viewWidth = self.bounds.size.width;

    // Drag handle frame - TOP of window
    // NSWindow contentView uses flipped coordinates: Y=0 is at top
    CGFloat x = self.dragHandleLeftInset;
    CGFloat y = 0;  // Top of window
    CGFloat width = viewWidth - self.dragHandleLeftInset - self.dragHandleRightInset;
    CGFloat height = self.dragHandleHeight;

    // Create a simple NSView with red border
    NSView* borderView = [[NSView alloc] initWithFrame:NSMakeRect(x, y, width, height)];
    borderView.wantsLayer = YES;
    borderView.layer.borderColor = [[NSColor redColor] CGColor];
    borderView.layer.borderWidth = 1.0;  // 2px for better visibility
    borderView.layer.backgroundColor = [[NSColor clearColor] CGColor];

    // Autoresizing: maintain distance from top, expand width
    borderView.autoresizingMask = NSViewWidthSizable | NSViewMaxYMargin;

    NSLog(@"[DraggableAcceptingWebView] Created debug border view: frame=(%.1f, %.1f, %.1f, %.1f)",
          x, y, width, height);

    _debugBorderView = borderView;
    return borderView;
}

@end
