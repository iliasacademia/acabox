#import "AcademiaNotificationsButton.h"
#import <QuartzCore/QuartzCore.h>

@implementation AcademiaNotificationsButton

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
        NSLog(@"[AcademiaNotificationsButton] ContentView layer configured - wantsLayer: YES, masksToBounds: NO");

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

        // Initialize polling properties
        self.lastCount = -1;  // -1 indicates no count fetched yet
        self.pollTimer = nil;
        self.apiBaseUrl = @"http://127.0.0.1:23111";  // Default base URL
        self.authToken = nil;

        NSLog(@"[AcademiaNotificationsButton] Initialized with default API base URL: %@", self.apiBaseUrl);

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
    [super orderOut:sender];
}

- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame {
    // DISABLED FOR TESTING: No mask applied, 50px window should show everything
    NSLog(@"[AcademiaNotificationsButton] Clipping DISABLED - 50px window test, no mask applied");
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

    NSLog(@"[AcademiaNotificationsButton] Applied clipping mask - local visible rect: (%.1f, %.1f, %.1f, %.1f)",
          localVisible.origin.x, localVisible.origin.y, localVisible.size.width, localVisible.size.height);
}

- (void)clearVisibleRectMask {
    // DISABLED FOR TESTING: No mask to clear
    NSLog(@"[AcademiaNotificationsButton] clearVisibleRectMask called - no mask to clear (disabled)");
    return;

    // OLD CODE BELOW (disabled):
    // Remove mask to show full button
    self.contentView.layer.mask = nil;
    NSLog(@"[AcademiaNotificationsButton] Cleared clipping mask");
}

- (void)updateBadge:(int)count {
    NSLog(@"[AcademiaNotificationsButton] ========== updateBadge START ==========");
    NSLog(@"[AcademiaNotificationsButton] Received count: %d", count);
    NSLog(@"[AcademiaNotificationsButton] Previous badgeCount: %d", self.badgeCount);
    NSLog(@"[AcademiaNotificationsButton] badgeView exists: %@", self.badgeView ? @"YES" : @"NO");
    NSLog(@"[AcademiaNotificationsButton] badgeLabel exists: %@", self.badgeLabel ? @"YES" : @"NO");
    NSLog(@"[AcademiaNotificationsButton] badgeView.hidden (before): %@", self.badgeView.hidden ? @"YES" : @"NO");

    // Update badge visibility and count based on undismissed notifications
    self.badgeCount = count;  // Store count for debugging

    if (count > 0) {
        NSLog(@"[AcademiaNotificationsButton] count > 0, showing badge");
        // Show badge with count
        NSString* countText;
        if (count > 9) {
            countText = @"9+";
            NSLog(@"[AcademiaNotificationsButton] count > 9, displaying '9+'");
        } else {
            countText = [NSString stringWithFormat:@"%d", count];
            NSLog(@"[AcademiaNotificationsButton] Displaying exact count: %d", count);
        }

        NSLog(@"[AcademiaNotificationsButton] Setting badgeLabel.stringValue = '%@'", countText);
        self.badgeLabel.stringValue = countText;

        NSLog(@"[AcademiaNotificationsButton] Setting badgeView.hidden = NO");
        self.badgeView.hidden = NO;

        NSLog(@"[AcademiaNotificationsButton] Badge updated and visible with count: %d", count);
    } else {
        NSLog(@"[AcademiaNotificationsButton] count = 0, hiding badge");
        // Hide badge when no undismissed notifications
        self.badgeView.hidden = YES;
        NSLog(@"[AcademiaNotificationsButton] Badge hidden (no undismissed notifications)");
    }

    NSLog(@"[AcademiaNotificationsButton] badgeView.hidden (after): %@", self.badgeView.hidden ? @"YES" : @"NO");
    NSLog(@"[AcademiaNotificationsButton] badgeLabel.stringValue (after): '%@'", self.badgeLabel.stringValue);
    NSLog(@"[AcademiaNotificationsButton] ========== updateBadge END ==========");
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

- (void)startPolling {
    // Don't start polling if base URL not set
    if (!self.apiBaseUrl) {
        NSLog(@"[AcademiaNotificationsButton] Cannot start polling - API base URL not set");
        return;
    }

    NSLog(@"[AcademiaNotificationsButton] Starting notification count polling (1 second interval, no auth)");

    // Stop existing timer if any
    [self stopPolling];

    // Create timer that fires every 1 second
    self.pollTimer = [NSTimer scheduledTimerWithTimeInterval:10.0
                                                      target:self
                                                    selector:@selector(fetchNotificationCount)
                                                    userInfo:nil
                                                     repeats:YES];

    // Also fetch immediately
    [self fetchNotificationCount];
}

- (void)stopPolling {
    NSLog(@"[AcademiaNotificationsButton] Stopping notification count polling");

    if (self.pollTimer) {
        [self.pollTimer invalidate];
        self.pollTimer = nil;
    }
}

- (void)fetchNotificationCount {
    // Don't fetch if base URL not set
    if (!self.apiBaseUrl) {
        NSLog(@"[AcademiaNotificationsButton] Cannot fetch - API base URL not set");
        return;
    }

    // Construct API URL
    NSString* urlString = [NSString stringWithFormat:@"%@/api/notifications/count", self.apiBaseUrl];
    NSURL* url = [NSURL URLWithString:urlString];

    if (!url) {
        NSLog(@"[AcademiaNotificationsButton] Invalid API URL: %@", urlString);
        return;
    }

    // Create request (no auth required)
    NSMutableURLRequest* request = [NSMutableURLRequest requestWithURL:url];
    [request setHTTPMethod:@"GET"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    [request setTimeoutInterval:2.0];  // 2 second timeout

    // Make async request
    NSURLSession* session = [NSURLSession sharedSession];
    NSURLSessionDataTask* task = [session dataTaskWithRequest:request
                                            completionHandler:^(NSData* data, NSURLResponse* response, NSError* error) {
        if (error) {
            NSLog(@"[AcademiaNotificationsButton] Error fetching notification count: %@", error.localizedDescription);
            return;
        }

        NSHTTPURLResponse* httpResponse = (NSHTTPURLResponse*)response;
        if (httpResponse.statusCode != 200) {
            NSLog(@"[AcademiaNotificationsButton] HTTP error %ld when fetching notification count", (long)httpResponse.statusCode);
            return;
        }

        // Parse JSON response
        NSError* jsonError = nil;
        NSDictionary* json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];

        if (jsonError) {
            NSLog(@"[AcademiaNotificationsButton] JSON parse error: %@", jsonError.localizedDescription);
            return;
        }

        // Extract total count
        NSNumber* totalNumber = json[@"total"];
        if (!totalNumber) {
            NSLog(@"[AcademiaNotificationsButton] No 'total' field in response");
            return;
        }

        int total = [totalNumber intValue];
        NSLog(@"[AcademiaNotificationsButton] Fetched notification count: %d (last: %d)", total, self.lastCount);

        // Update badge if count changed
        if (total != self.lastCount) {
            NSLog(@"[AcademiaNotificationsButton] Count changed from %d to %d, updating badge", self.lastCount, total);
            self.lastCount = total;

            // Update badge on main thread
            dispatch_async(dispatch_get_main_queue(), ^{
                [self updateBadge:total];
            });
        }
    }];

    [task resume];
}

- (void)dealloc {
    // Stop polling and cleanup
    [self stopPolling];
}

#pragma mark - OverlayWindow Protocol

- (void)updatePositionWithWordState:(WordPositionState)state {
    // Position button at bottom-left of Word scroll area

    // If scrollAreaBounds is empty, hide the button
    if (CGRectIsEmpty(state.scrollAreaBounds)) {
        NSLog(@"[AcademiaNotificationsButton] Cannot position - scrollAreaBounds is empty, hiding button");
        [self hide];
        return;
    }

    // Button dimensions
    CGFloat buttonSize = 24.0;
    CGFloat badgeSize = 12.0;
    CGFloat badgeOverhang = badgeSize * 0.5;  // 6px
    CGFloat windowWidth = buttonSize + badgeOverhang;  // 30px to accommodate badge
    CGFloat windowHeight = buttonSize + badgeOverhang;  // 30px to accommodate badge

    // Margins from scroll area edges
    CGFloat leftMargin = 50.0;   // Space from left edge of scroll area
    CGFloat bottomMargin = 12.0;  // Space from bottom edge of scroll area

    // Get primary screen for coordinate conversion
    NSScreen* primaryScreen = [NSScreen screens][0];
    CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

    // scrollAreaBounds is in Accessibility coordinates (top-left origin)
    // Need to convert to Cocoa coordinates (bottom-left origin)

    // Calculate bottom-left corner of scroll area in Cocoa coordinates
    // AX: scrollAreaBounds.origin.y is the TOP of the scroll area
    // AX: scrollAreaBounds.origin.y + scrollAreaBounds.size.height is the BOTTOM of the scroll area
    CGFloat scrollAreaBottomAX = state.scrollAreaBounds.origin.y + state.scrollAreaBounds.size.height;
    CGFloat scrollAreaBottomCocoa = primaryScreenHeight - scrollAreaBottomAX;

    // Position button at bottom-left with margins
    // X: Scroll area left + margin
    CGFloat buttonX = state.scrollAreaBounds.origin.x + leftMargin;
    // Y: Scroll area bottom (in Cocoa coords) + margin
    CGFloat buttonY = scrollAreaBottomCocoa + bottomMargin;

    // Set button frame
    NSRect newFrame = NSMakeRect(buttonX, buttonY, windowWidth, windowHeight);
    [self setFrame:newFrame display:YES];

    // Update button frame within window (button is 24x24, positioned at origin)
    self.button.frame = NSMakeRect(0, 0, buttonSize, buttonSize);

    // Update badge position (top-right of button with overlap)
    CGFloat badgeX = buttonSize - badgeOverhang;  // 24 - 6 = 18
    CGFloat badgeY = 0 - badgeOverhang;  // -6 (overlaps top edge)
    self.badgeView.frame = NSMakeRect(badgeX, badgeY, badgeSize, badgeSize);

    NSLog(@"[AcademiaNotificationsButton] Positioned at (%.1f, %.1f) based on scroll area at (%.1f, %.1f, %.1f, %.1f)",
          buttonX, buttonY,
          state.scrollAreaBounds.origin.x, state.scrollAreaBounds.origin.y,
          state.scrollAreaBounds.size.width, state.scrollAreaBounds.size.height);
}

- (void)hide {
    NSLog(@"[AcademiaNotificationsButton] hide called");
    [self stopPolling];  // Stop polling when button is hidden
    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[AcademiaNotificationsButton] show called");
    [self orderFront:nil];
    [self startPolling];  // Start polling when button is shown
}

// isVisible is inherited from NSWindow - no need to override

- (void)updateBadgeCount:(NSInteger)count {
    NSLog(@"[AcademiaNotificationsButton] updateBadgeCount: %ld (via protocol)", (long)count);
    [self updateBadge:(int)count];
}

- (NSString *)overlayIdentifier {
    return @"NotificationsButton";
}

@end
