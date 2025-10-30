#import "ResizeHandleView.h"

@implementation ResizeHandleView

- (instancetype)initWithFrame:(NSRect)frameRect window:(NSWindow*)window {
    self = [super initWithFrame:frameRect];
    if (self) {
        self.windowToResize = window;
        self.isHovering = NO;

        // Start invisible
        self.alphaValue = 0.0;

        // Setup tracking area for hover detection
        [self setupTrackingArea];
    }
    return self;
}

#pragma mark - Tracking Area Setup

- (void)setupTrackingArea {
    // Create a larger tracking area than the view itself for better hover detection
    NSRect trackingRect = NSInsetRect(self.bounds, -30, -30);

    NSTrackingArea *trackingArea = [[NSTrackingArea alloc]
        initWithRect:trackingRect
        options:NSTrackingMouseEnteredAndExited |
                NSTrackingMouseMoved |
                NSTrackingActiveAlways |
                NSTrackingInVisibleRect
        owner:self
        userInfo:nil];

    [self addTrackingArea:trackingArea];
    self.trackingArea = trackingArea;
}

- (void)updateTrackingAreas {
    [super updateTrackingAreas];

    if (self.trackingArea) {
        [self removeTrackingArea:self.trackingArea];
    }

    [self setupTrackingArea];
}

#pragma mark - Mouse Tracking

- (void)mouseEntered:(NSEvent *)event {
    self.isHovering = YES;
    [self fadeIn];
}

- (void)mouseExited:(NSEvent *)event {
    self.isHovering = NO;
    [self fadeOut];
}

- (void)mouseMoved:(NSEvent *)event {
    // Update cursor when hovering over the handle
    [[NSCursor closedHandCursor] set];
}

#pragma mark - Fade Animations

- (void)fadeIn {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.2;
        self.animator.alphaValue = 1.0;
    } completionHandler:nil];
}

- (void)fadeOut {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.2;
        self.animator.alphaValue = 0.0;
    } completionHandler:nil];
}

#pragma mark - Mouse Events for Resizing

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    // Allow dragging without activating the window
    return YES;
}

- (void)mouseDown:(NSEvent *)event {
    // Store initial positions for resize calculation
    self.dragStartLocation = [NSEvent mouseLocation];
    self.windowStartFrame = self.windowToResize.frame;

    NSLog(@"[ResizeHandleView] Starting resize from: %@", NSStringFromPoint(self.dragStartLocation));
}

- (void)mouseDragged:(NSEvent *)event {
    if (!self.windowToResize) return;

    // Get current mouse location in screen coordinates
    NSPoint currentLocation = [NSEvent mouseLocation];

    // Calculate delta from start
    CGFloat deltaX = currentLocation.x - self.dragStartLocation.x;
    CGFloat deltaY = currentLocation.y - self.dragStartLocation.y;

    // Calculate new frame (bottom-right corner resize)
    NSRect newFrame = self.windowStartFrame;
    newFrame.size.width += deltaX;
    newFrame.size.height -= deltaY;  // Subtract because screen coords go up, but we want to drag down
    newFrame.origin.y += deltaY;     // Adjust origin to keep top-left fixed

    // Apply size constraints from window
    NSSize minSize = self.windowToResize.minSize;
    NSSize maxSize = self.windowToResize.maxSize;

    if (newFrame.size.width < minSize.width) newFrame.size.width = minSize.width;
    if (newFrame.size.height < minSize.height) {
        newFrame.size.height = minSize.height;
        newFrame.origin.y = self.windowStartFrame.origin.y + self.windowStartFrame.size.height - minSize.height;
    }

    if (newFrame.size.width > maxSize.width) newFrame.size.width = maxSize.width;
    if (newFrame.size.height > maxSize.height) {
        newFrame.size.height = maxSize.height;
        newFrame.origin.y = self.windowStartFrame.origin.y + self.windowStartFrame.size.height - maxSize.height;
    }

    // Update window frame
    [self.windowToResize setFrame:newFrame display:YES animate:NO];
}

- (void)mouseUp:(NSEvent *)event {
    NSLog(@"[ResizeHandleView] Resize complete");
}

#pragma mark - Cursor Updates

- (void)cursorUpdate:(NSEvent *)event {
    [[NSCursor closedHandCursor] set];
}

- (void)resetCursorRects {
    [self addCursorRect:self.bounds cursor:[NSCursor closedHandCursor]];
}

#pragma mark - Drawing

- (void)drawRect:(NSRect)dirtyRect {
    [super drawRect:dirtyRect];

    // Draw grip lines in the handle area
    NSBezierPath *path = [NSBezierPath bezierPath];
    path.lineWidth = 1.5;

    // Set color (semi-transparent gray/white)
    [[NSColor colorWithWhite:0.5 alpha:0.7] setStroke];

    CGFloat size = self.bounds.size.width;
    CGFloat spacing = 4.0;

    // Draw three diagonal lines (grip pattern)
    for (int i = 0; i < 3; i++) {
        CGFloat offset = i * spacing;

        // Line from bottom-left to top-right
        [path moveToPoint:NSMakePoint(offset, 0)];
        [path lineToPoint:NSMakePoint(size, size - offset)];
    }

    [path stroke];
}

@end
