#import "NativeHeaderView.h"

@implementation NativeHeaderView

- (instancetype)initWithFrame:(NSRect)frame window:(NSWindow*)window {
    self = [super initWithFrame:frame];
    if (self) {
        self.titleText = @"Suggestions";
        self.badgeCount = 0;
        self.windowToMove = window;
        self.isHoveringCloseButton = NO;

        // Enable layer for better rendering
        self.wantsLayer = YES;

        // Setup tracking area for mouse hover
        [self setupTrackingArea];
    }
    return self;
}

- (void)setupTrackingArea {
    NSTrackingArea *trackingArea = [[NSTrackingArea alloc]
        initWithRect:self.bounds
        options:NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved | NSTrackingActiveAlways
        owner:self
        userInfo:nil];
    [self addTrackingArea:trackingArea];
}

- (void)updateBadgeCount:(int)count {
    self.badgeCount = count;
    [self setNeedsDisplay:YES];
}

#pragma mark - Drawing

- (void)drawRect:(NSRect)dirtyRect {
    [super drawRect:dirtyRect];

    // Get bounds
    NSRect bounds = self.bounds;

    // Draw background (#f8f9fa)
    [[NSColor colorWithRed:0.973 green:0.976 blue:0.980 alpha:1.0] setFill];
    NSRectFill(bounds);

    // Draw bottom border (#e9ecef)
    [[NSColor colorWithRed:0.914 green:0.925 blue:0.937 alpha:1.0] setFill];
    NSRect borderRect = NSMakeRect(0, 0, bounds.size.width, 1);
    NSRectFill(borderRect);

    // Draw title text "Suggestions"
    [self drawTitleText];

    // Draw badge with count
    [self drawBadge];

    // Draw close button
    [self drawCloseButton];
}

- (void)drawTitleText {
    NSRect bounds = self.bounds;

    // Title attributes
    NSDictionary *titleAttributes = @{
        NSFontAttributeName: [NSFont systemFontOfSize:18 weight:NSFontWeightSemibold],
        NSForegroundColorAttributeName: [NSColor colorWithRed:0.129 green:0.145 blue:0.161 alpha:1.0] // #212529
    };

    NSString *title = self.titleText;
    NSSize titleSize = [title sizeWithAttributes:titleAttributes];

    // Position: 16px from left, vertically centered
    CGFloat titleX = 16;
    CGFloat titleY = (bounds.size.height - titleSize.height) / 2;
    NSPoint titleOrigin = NSMakePoint(titleX, titleY);

    [title drawAtPoint:titleOrigin withAttributes:titleAttributes];
}

- (void)drawBadge {
    NSRect bounds = self.bounds;

    // Badge text
    NSString *badgeText = [NSString stringWithFormat:@"%d", self.badgeCount];

    // Badge attributes
    NSDictionary *badgeTextAttributes = @{
        NSFontAttributeName: [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold],
        NSForegroundColorAttributeName: [NSColor whiteColor]
    };

    NSSize badgeTextSize = [badgeText sizeWithAttributes:badgeTextAttributes];

    // Badge dimensions
    CGFloat badgePadding = 10;
    CGFloat badgeWidth = badgeTextSize.width + badgePadding * 2;
    CGFloat badgeHeight = 24;

    // Position: after title with some spacing
    NSDictionary *titleAttributes = @{
        NSFontAttributeName: [NSFont systemFontOfSize:18 weight:NSFontWeightSemibold]
    };
    NSSize titleSize = [self.titleText sizeWithAttributes:titleAttributes];

    CGFloat badgeX = 16 + titleSize.width + 12;  // 12px gap after title
    CGFloat badgeY = (bounds.size.height - badgeHeight) / 2;

    NSRect badgeRect = NSMakeRect(badgeX, badgeY, badgeWidth, badgeHeight);

    // Draw badge background (#007bff)
    NSBezierPath *badgePath = [NSBezierPath bezierPathWithRoundedRect:badgeRect xRadius:12 yRadius:12];
    [[NSColor colorWithRed:0.0 green:0.482 blue:1.0 alpha:1.0] setFill];
    [badgePath fill];

    // Draw badge text
    CGFloat textX = badgeX + (badgeWidth - badgeTextSize.width) / 2;
    CGFloat textY = badgeY + (badgeHeight - badgeTextSize.height) / 2;
    [badgeText drawAtPoint:NSMakePoint(textX, textY) withAttributes:badgeTextAttributes];
}

- (void)drawCloseButton {
    NSRect bounds = self.bounds;

    // Close button dimensions
    CGFloat buttonSize = 20;
    CGFloat buttonX = bounds.size.width - buttonSize - 16;  // 16px from right
    CGFloat buttonY = (bounds.size.height - buttonSize) / 2;

    NSRect buttonRect = NSMakeRect(buttonX, buttonY, buttonSize, buttonSize);

    // Draw button circle
    NSBezierPath *circlePath = [NSBezierPath bezierPathWithOvalInRect:buttonRect];

    if (self.isHoveringCloseButton) {
        // Hover: red background with white X
        [[NSColor colorWithRed:0.906 green:0.067 blue:0.137 alpha:1.0] setFill];  // #e81123
        [circlePath fill];

        // Draw white X
        [self drawCloseXInRect:buttonRect color:[NSColor whiteColor]];
    } else {
        // Normal: transparent background with gray X
        [[NSColor clearColor] setFill];
        [circlePath fill];

        // Draw gray X
        [self drawCloseXInRect:buttonRect color:[NSColor colorWithRed:0.424 green:0.459 blue:0.490 alpha:1.0]];  // #6c757d
    }
}

- (void)drawCloseXInRect:(NSRect)rect color:(NSColor*)color {
    // Draw X symbol
    CGFloat margin = 6;
    NSPoint topLeft = NSMakePoint(rect.origin.x + margin, rect.origin.y + rect.size.height - margin);
    NSPoint bottomRight = NSMakePoint(rect.origin.x + rect.size.width - margin, rect.origin.y + margin);
    NSPoint topRight = NSMakePoint(rect.origin.x + rect.size.width - margin, rect.origin.y + rect.size.height - margin);
    NSPoint bottomLeft = NSMakePoint(rect.origin.x + margin, rect.origin.y + margin);

    NSBezierPath *xPath = [NSBezierPath bezierPath];
    [xPath setLineWidth:2.0];

    // First line of X
    [xPath moveToPoint:topLeft];
    [xPath lineToPoint:bottomRight];

    // Second line of X
    [xPath moveToPoint:topRight];
    [xPath lineToPoint:bottomLeft];

    [color setStroke];
    [xPath stroke];
}

#pragma mark - Mouse Event Handling

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    // Allow dragging immediately without activating window
    return YES;
}

- (void)mouseDown:(NSEvent *)event {
    NSPoint locationInView = [self convertPoint:event.locationInWindow fromView:nil];

    // Check if clicking close button
    if ([self isPointInCloseButton:locationInView]) {
        // Close button clicked - trigger action
        if (self.target && self.closeAction) {
            #pragma clang diagnostic push
            #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
            [self.target performSelector:self.closeAction withObject:self];
            #pragma clang diagnostic pop
        }
        return;
    }

    // Otherwise, start dragging
    self.dragStartLocation = [NSEvent mouseLocation];
    self.windowStartOrigin = self.windowToMove.frame.origin;
}

- (void)mouseDragged:(NSEvent *)event {
    // Get current mouse location in screen coordinates
    NSPoint currentLocation = [NSEvent mouseLocation];

    // Calculate delta
    CGFloat deltaX = currentLocation.x - self.dragStartLocation.x;
    CGFloat deltaY = currentLocation.y - self.dragStartLocation.y;

    // Calculate new window origin
    NSPoint newOrigin = NSMakePoint(
        self.windowStartOrigin.x + deltaX,
        self.windowStartOrigin.y + deltaY
    );

    // Move the window
    [self.windowToMove setFrameOrigin:newOrigin];
}

- (void)mouseMoved:(NSEvent *)event {
    NSPoint locationInView = [self convertPoint:event.locationInWindow fromView:nil];

    BOOL wasHovering = self.isHoveringCloseButton;
    self.isHoveringCloseButton = [self isPointInCloseButton:locationInView];

    // Redraw if hover state changed
    if (wasHovering != self.isHoveringCloseButton) {
        [self setNeedsDisplay:YES];
    }

    // Update cursor
    if (self.isHoveringCloseButton) {
        [[NSCursor arrowCursor] set];
    } else {
        [[NSCursor openHandCursor] set];
    }
}

- (void)mouseExited:(NSEvent *)event {
    if (self.isHoveringCloseButton) {
        self.isHoveringCloseButton = NO;
        [self setNeedsDisplay:YES];
    }
    [[NSCursor arrowCursor] set];
}

- (void)cursorUpdate:(NSEvent *)event {
    if (self.isHoveringCloseButton) {
        [[NSCursor arrowCursor] set];
    } else {
        [[NSCursor openHandCursor] set];
    }
}

#pragma mark - Helper Methods

- (BOOL)isPointInCloseButton:(NSPoint)point {
    NSRect bounds = self.bounds;

    // Close button dimensions
    CGFloat buttonSize = 20;
    CGFloat buttonX = bounds.size.width - buttonSize - 16;
    CGFloat buttonY = (bounds.size.height - buttonSize) / 2;

    NSRect buttonRect = NSMakeRect(buttonX, buttonY, buttonSize, buttonSize);

    return NSPointInRect(point, buttonRect);
}

@end
