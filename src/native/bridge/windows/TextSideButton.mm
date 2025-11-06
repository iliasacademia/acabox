#import "TextSideButton.h"
#import "../../bridge.h"
#import "../views/DraggableAcceptingWebView.h"

@implementation TextSideButton

- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer searchText:(NSString*)text {
    CGFloat width = 24.0;
    CGFloat height = 24.0;

    // Call base class initializer
    self = [super initWithSize:CGSizeMake(width, height)
                   windowLevel:NSFloatingWindowLevel
                      observer:observer];
    if (self) {
        self.searchText = text;

        // Make background transparent
        self.backgroundColor = [NSColor clearColor];
        self.opaque = NO;

        // CRITICAL: Make panel non-activating so clicking doesn't steal focus
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;
        self.worksWhenModal = YES;
        self.hidesOnDeactivate = NO;

        // Standard collection behavior
        self.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary |
                                   NSWindowCollectionBehaviorIgnoresCycle;

        // Disable dragging by setting drag handle height to 0
        if ([self.webView isKindOfClass:[DraggableAcceptingWebView class]]) {
            DraggableAcceptingWebView* draggableWebView = (DraggableAcceptingWebView*)self.webView;
            draggableWebView.dragHandleHeight = 0.0;
            NSLog(@"[TextSideButton] Disabled dragging by setting dragHandleHeight to 0");
        }

        NSLog(@"[TextSideButton] Initialized with search text: %@", text);
    }
    return self;
}

#pragma mark - BasePopupWindow Overrides

- (void)loadPopupHTML {
    // Set HTML subpath BEFORE loading (called by base class init)
    self.htmlSubpath = @"textSideButton";
    NSLog(@"[TextSideButton] Loading with subpath: %@", self.htmlSubpath);

    // Call parent implementation which will use the subpath
    [super loadPopupHTML];
}

- (NSString*)windowNameForLogging {
    return @"TextSideButton";
}

#pragma mark - OverlayWindow Protocol

- (void)updatePositionWithWordState:(WordPositionState)state {
    NSLog(@"[TextSideButton] updatePositionWithWordState called for text: %@", self.searchText);

    // Get MicrosoftWordAdapter from observer
    MicrosoftWordAdapter* adapter = nil;
    if ([self.observer respondsToSelector:@selector(getWordAdapter)]) {
        adapter = [self.observer performSelector:@selector(getWordAdapter)];
    }

    if (!adapter) {
        NSLog(@"[TextSideButton] ERROR: No adapter available");
        [self hide];
        return;
    }

    // Call findTextPosition to get text bounds
    CGRect textBounds = [adapter findTextPosition:self.searchText];

    if (CGRectEqualToRect(textBounds, CGRectZero)) {
        NSLog(@"[TextSideButton] Text not found or invalid bounds, hiding button");
        [self hide];
        return;
    }

    NSLog(@"[TextSideButton] Found text at: x=%.1f, y=%.1f, w=%.1f, h=%.1f",
          textBounds.origin.x, textBounds.origin.y, textBounds.size.width, textBounds.size.height);

    // Validate scroll area bounds
    if (CGRectIsEmpty(state.scrollAreaBounds)) {
        NSLog(@"[TextSideButton] Cannot position - scrollAreaBounds is empty");
        [self hide];
        return;
    }

    // Check if text position is within scroll area
    CGFloat scrollMinX = state.scrollAreaBounds.origin.x;
    CGFloat scrollMaxX = state.scrollAreaBounds.origin.x + state.scrollAreaBounds.size.width;
    CGFloat scrollMinY = state.scrollAreaBounds.origin.y;
    CGFloat scrollMaxY = state.scrollAreaBounds.origin.y + state.scrollAreaBounds.size.height;

    BOOL xOutOfBounds = textBounds.origin.x < scrollMinX || textBounds.origin.x > scrollMaxX;
    BOOL yOutOfBounds = textBounds.origin.y < scrollMinY || textBounds.origin.y > scrollMaxY;

    if (xOutOfBounds || yOutOfBounds) {
        NSLog(@"[TextSideButton] Text position (%.1f, %.1f) outside scroll area, hiding button",
              textBounds.origin.x, textBounds.origin.y);
        [self hide];
        return;
    }

    // Calculate button position
    CGFloat buttonWidth = self.frame.size.width;
    CGFloat buttonHeight = self.frame.size.height;

    NSScreen* primaryScreen = [NSScreen screens][0];
    CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

    // Convert from Accessibility coordinates (top-left origin) to Cocoa coordinates (bottom-left origin)
    CGFloat cocoaY = primaryScreenHeight - textBounds.origin.y;

    // Position button 8px from the left edge of the layout bounds
    CGFloat leftOffset = 8.0;
    CGFloat buttonX = state.layoutPosition.x + leftOffset;
    CGFloat buttonY = cocoaY - buttonHeight;

    NSRect newFrame = NSMakeRect(buttonX, buttonY, buttonWidth, buttonHeight);
    [self setFrame:newFrame display:YES];

    NSLog(@"[TextSideButton] Positioned at (%.1f, %.1f) next to text at (%.1f, %.1f)",
          buttonX, buttonY, textBounds.origin.x, textBounds.origin.y);

    [self show];
}

- (void)hide {
    NSLog(@"[TextSideButton] hide called");
    [self orderOut:nil];
}

- (void)show {
    NSLog(@"[TextSideButton] show called");
    [self orderFront:nil];
}

- (NSString *)overlayIdentifier {
    return [NSString stringWithFormat:@"TextSideButton-%@", self.searchText];
}

#pragma mark - Window Lifecycle

- (void)orderOut:(id)sender {
    [super orderOut:sender];
}

@end
