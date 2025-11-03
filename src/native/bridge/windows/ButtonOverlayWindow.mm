#import "ButtonOverlayWindow.h"
#import "TextPopupWindow.h"
#import <QuartzCore/QuartzCore.h>

@implementation ButtonOverlayWindow

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer {
    // Create borderless, transparent panel - fixed size for circular button (24px)
    // Use NSPanel with non-activating style to prevent stealing focus from Word
    CGFloat buttonSize = 24.0;
    CGFloat badgeSize = 12.0;
    CGFloat badgeOverlap = badgeSize * 0.5;  // Badge overlaps button by half its size (6px)
    CGFloat windowSize = 50.0;  // TESTING: 50px window to ensure badge is visible
    self = [super initWithContentRect:NSMakeRect(0, 0, windowSize, windowSize)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];
    if (self) {
        self.observer = observer;
        self.backgroundColor = [NSColor clearColor];
        self.opaque = NO;
        self.level = NSFloatingWindowLevel;  // Always on top
        self.ignoresMouseEvents = NO;
        self.hasShadow = YES;
        self.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary |
                                   NSWindowCollectionBehaviorIgnoresCycle;

        // CRITICAL: Make panel non-activating so clicking button doesn't steal focus
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;  // Never become key window
        self.worksWhenModal = YES;  // Continue working even when modal dialogs are present
        self.hidesOnDeactivate = NO;  // Don't auto-hide when app deactivates

        // CRITICAL: Explicitly enable layer backing for contentView to prevent auto-clipping
        // Without this, accessing contentView.layer creates an auto-layer with clipping enabled
        self.contentView.wantsLayer = YES;
        self.contentView.layer.masksToBounds = NO;
        self.contentView.layer.mask = nil;  // Clear any existing mask
        NSLog(@"[ButtonOverlayWindow] ContentView layer configured - wantsLayer: YES, masksToBounds: NO");

        // Create circular button with white "A" letter
        self.button = [[NSButton alloc] initWithFrame:NSMakeRect(0, 0, buttonSize, buttonSize)];
        self.button.title = @"A";
        self.button.font = [NSFont boldSystemFontOfSize:14];
        self.button.bezelStyle = NSBezelStyleInline;
        self.button.bordered = NO;

        // Set up button action
        self.button.target = self;
        self.button.action = @selector(buttonClicked:);

        // Style the button as black circle with white text
        self.button.wantsLayer = YES;
        self.button.layer.backgroundColor = [[NSColor colorWithRed:0.0 green:0.0 blue:0.0 alpha:0.9] CGColor];
        self.button.layer.cornerRadius = buttonSize / 2;  // Make it circular
        self.button.layer.masksToBounds = NO;  // Allow badge to extend beyond button bounds

        // Set text color to white
        NSMutableAttributedString *title = [[NSMutableAttributedString alloc] initWithString:@"A"];
        [title addAttribute:NSForegroundColorAttributeName
                     value:[NSColor whiteColor]
                     range:NSMakeRange(0, title.length)];
        [title addAttribute:NSFontAttributeName
                     value:[NSFont boldSystemFontOfSize:14]
                     range:NSMakeRange(0, title.length)];
        self.button.attributedTitle = title;

        [self.contentView addSubview:self.button];

        // Create badge view (red circle with white text for notification count)
        // Badge is 12px diameter, positioned at top-right of button
        // badgeSize is already declared above
        CGFloat badgeX = buttonSize - (badgeSize * 0.5);  // Positioned at right edge, overlapping
        // Button has isFlipped=YES (top-left origin), so Y=0 is at TOP
        CGFloat badgeY = 0 - (badgeSize * 0.5);  // = -6 (positioned at top edge, overlapping)

        self.badgeView = [[NSView alloc] initWithFrame:NSMakeRect(badgeX, badgeY, badgeSize, badgeSize)];
        self.badgeView.wantsLayer = YES;
        self.badgeView.layer.backgroundColor = [[NSColor colorWithRed:1.0 green:0.0 blue:0.0 alpha:1.0] CGColor];
        self.badgeView.layer.cornerRadius = badgeSize / 2;  // Make it circular
        self.badgeView.layer.borderColor = [[NSColor whiteColor] CGColor];
        self.badgeView.layer.borderWidth = 1.0;  // White border for contrast
        self.badgeView.hidden = YES;  // Initially hidden

        // Create label for notification count
        self.badgeLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, badgeSize, badgeSize)];
        self.badgeLabel.stringValue = @"";
        self.badgeLabel.font = [NSFont boldSystemFontOfSize:8];
        self.badgeLabel.textColor = [NSColor whiteColor];
        self.badgeLabel.backgroundColor = [NSColor clearColor];
        self.badgeLabel.bordered = NO;
        self.badgeLabel.editable = NO;
        self.badgeLabel.selectable = NO;
        self.badgeLabel.alignment = NSTextAlignmentCenter;

        [self.badgeView addSubview:self.badgeLabel];
        [self.button addSubview:self.badgeView];  // Badge is now a subview of button, not window

        // Add mouse tracking for hover (disabled for now - just console logging)
        // [self setupMouseTracking];
    }
    return self;
}

- (void)setSelectedText:(NSString*)text {
    _selectedText = text;
}

- (void)buttonClicked:(id)sender {
    // When button is clicked, notify the observer
    if (self.observer) {
        // Use performSelector to avoid forward declaration issues
        id observer = self.observer;
        #pragma clang diagnostic push
        #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        [observer performSelector:@selector(handleButtonClick)];
        #pragma clang diagnostic pop
    }
}

- (void)positionAtPoint:(CGPoint)point withHeight:(CGFloat)selectionHeight {
    // Find which screen contains this point
    // The Accessibility API returns coordinates in a global coordinate system
    // We need to find which screen contains these coordinates

    NSScreen* targetScreen = nil;

    // Get the primary screen height to convert from top-left to bottom-left coordinates
    NSScreen* primaryScreen = [NSScreen screens][0];  // Screen with origin (0,0)
    CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

    // Convert accessibility point (top-left origin) to Cocoa coordinates (bottom-left origin)
    CGFloat cocoaY = primaryScreenHeight - point.y;

    // Find the screen that contains this point
    for (NSScreen* screen in [NSScreen screens]) {
        NSRect screenFrame = screen.frame;

        // Check if point is within this screen's bounds (in Cocoa coordinates)
        if (point.x >= screenFrame.origin.x &&
            point.x <= screenFrame.origin.x + screenFrame.size.width &&
            cocoaY >= screenFrame.origin.y &&
            cocoaY <= screenFrame.origin.y + screenFrame.size.height) {
            targetScreen = screen;
            break;
        }
    }

    // Fall back to main screen if no screen found
    if (!targetScreen) {
        targetScreen = [NSScreen mainScreen];
    }

    // Calculate window Y position
    // point.y is the TOP of the selection (in top-left coordinate system)
    // We need to position the window so it spans from top to bottom of selection
    // In Cocoa coordinates (bottom-left origin), the window origin is at the bottom-left
    // So: windowY = cocoaY - selectionHeight
    CGFloat windowY = cocoaY - selectionHeight;

    // Resize window and button to match selection height
    // Window must accommodate badge (badge extends 6px beyond button's right and top edges)
    CGFloat buttonSize = 24.0;
    CGFloat badgeSize = 12.0;
    CGFloat badgeOverhang = badgeSize * 0.5;  // 6px
    CGFloat windowWidth = buttonSize + badgeOverhang;  // 30px
    NSRect newFrame = NSMakeRect(point.x, windowY, windowWidth, selectionHeight);
    [self setFrame:newFrame display:YES];

    // Update button frame - button remains 24px wide, matches selection height
    self.button.frame = NSMakeRect(0, 0, buttonSize, selectionHeight);

    // Update badge position to stay at top-right of button
    CGFloat badgeX = buttonSize - badgeOverhang;  // Right edge: 24 - 6 = 18
    // Button has isFlipped=YES (top-left origin), so Y=0 is at TOP
    CGFloat badgeY = 0 - badgeOverhang;  // = -6 (top edge with overlap)
    self.badgeView.frame = NSMakeRect(badgeX, badgeY, badgeSize, badgeSize);

    // Update tracking area for new button size (disabled - hover functionality removed)
    // if (self.trackingArea) {
    //     [self.button removeTrackingArea:self.trackingArea];
    // }
    // [self setupMouseTracking];
}

- (void)orderOut:(id)sender {
    // Destroy popup window when button is hidden
    [self destroyPopup];
    [super orderOut:sender];
}

- (void)destroyPopup {
    // Actually destroy the popup window (for cleanup)
    if (self.popupWindow) {
        NSLog(@"[ButtonOverlayWindow] Destroying popup window");
        [self.popupWindow orderOut:nil];
        [self.popupWindow close];
        self.popupWindow = nil;
    }
}

- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame {
    // DISABLED FOR TESTING: No mask applied, 50px window should show everything
    NSLog(@"[ButtonOverlayWindow] Clipping DISABLED - 50px window test, no mask applied");
    return;

    // OLD CODE BELOW (disabled):
    // Convert global visibleRect to button's local coordinates
    CGRect localVisible = CGRectMake(
        visibleRect.origin.x - fullFrame.origin.x,
        visibleRect.origin.y - fullFrame.origin.y,
        visibleRect.size.width,
        visibleRect.size.height
    );

    // Create mask layer with visible rect
    CAShapeLayer *maskLayer = [CAShapeLayer layer];
    CGPathRef path = CGPathCreateWithRect(localVisible, NULL);
    maskLayer.path = path;
    CGPathRelease(path);

    // Apply mask to content view
    self.contentView.layer.mask = maskLayer;

    NSLog(@"[ButtonOverlayWindow] Applied clipping mask - local visible rect: (%.1f, %.1f, %.1f, %.1f)",
          localVisible.origin.x, localVisible.origin.y, localVisible.size.width, localVisible.size.height);
}

- (void)clearVisibleRectMask {
    // DISABLED FOR TESTING: No mask to clear
    NSLog(@"[ButtonOverlayWindow] clearVisibleRectMask called - no mask to clear (disabled)");
    return;

    // OLD CODE BELOW (disabled):
    // Remove mask to show full button
    self.contentView.layer.mask = nil;
    NSLog(@"[ButtonOverlayWindow] Cleared clipping mask");
}

- (void)updateBadge:(int)count {
    NSLog(@"[ButtonOverlayWindow] ========== updateBadge START ==========");
    NSLog(@"[ButtonOverlayWindow] Received count: %d", count);
    NSLog(@"[ButtonOverlayWindow] Previous badgeCount: %d", self.badgeCount);
    NSLog(@"[ButtonOverlayWindow] badgeView exists: %@", self.badgeView ? @"YES" : @"NO");
    NSLog(@"[ButtonOverlayWindow] badgeLabel exists: %@", self.badgeLabel ? @"YES" : @"NO");
    NSLog(@"[ButtonOverlayWindow] badgeView.hidden (before): %@", self.badgeView.hidden ? @"YES" : @"NO");

    // Update badge visibility and count based on undismissed notifications
    self.badgeCount = count;  // Store count for debugging

    if (count > 0) {
        NSLog(@"[ButtonOverlayWindow] count > 0, showing badge");
        // Show badge with count
        NSString* countText;
        if (count > 9) {
            countText = @"9+";
            NSLog(@"[ButtonOverlayWindow] count > 9, displaying '9+'");
        } else {
            countText = [NSString stringWithFormat:@"%d", count];
            NSLog(@"[ButtonOverlayWindow] Displaying exact count: %d", count);
        }

        NSLog(@"[ButtonOverlayWindow] Setting badgeLabel.stringValue = '%@'", countText);
        self.badgeLabel.stringValue = countText;

        NSLog(@"[ButtonOverlayWindow] Setting badgeView.hidden = NO");
        self.badgeView.hidden = NO;

        NSLog(@"[ButtonOverlayWindow] Badge updated and visible with count: %d", count);
    } else {
        NSLog(@"[ButtonOverlayWindow] count = 0, hiding badge");
        // Hide badge when no undismissed notifications
        self.badgeView.hidden = YES;
        NSLog(@"[ButtonOverlayWindow] Badge hidden (no undismissed notifications)");
    }

    NSLog(@"[ButtonOverlayWindow] badgeView.hidden (after): %@", self.badgeView.hidden ? @"YES" : @"NO");
    NSLog(@"[ButtonOverlayWindow] badgeLabel.stringValue (after): '%@'", self.badgeLabel.stringValue);
    NSLog(@"[ButtonOverlayWindow] ========== updateBadge END ==========");
}

- (int)getBadgeCount {
    return self.badgeCount;
}

- (CGRect)getBadgeFrame {
    if (self.badgeView) {
        return self.badgeView.frame;
    }
    return CGRectZero;
}

- (void)dealloc {
    // Clean up popup window completely during dealloc
    [self destroyPopup];
}

@end
