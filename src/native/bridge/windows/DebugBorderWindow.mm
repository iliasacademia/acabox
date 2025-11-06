#import "DebugBorderWindow.h"
#import "../managers/AcademiaManager.h"

@implementation DebugBorderWindow {
    DebugBorderType _borderType;
    NSColor* _borderColor;
    NSView* _borderView;
    BOOL _isVisible;
}

- (instancetype)initWithBorderType:(DebugBorderType)borderType color:(NSColor*)color {
    // Start with a small initial frame - will be updated when Word state is available
    self = [super initWithContentRect:NSMakeRect(0, 0, 100, 100)
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];

    if (self) {
        _borderType = borderType;
        _borderColor = color;
        _isVisible = NO;

        // Configure window to be transparent and pass through mouse events
        self.backgroundColor = [NSColor clearColor];
        self.opaque = NO;
        self.level = NSFloatingWindowLevel + 2;  // Above other overlays
        self.ignoresMouseEvents = YES;  // Mouse events pass through
        self.hasShadow = NO;

        // Non-activating panel configuration
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;
        self.worksWhenModal = YES;
        self.hidesOnDeactivate = NO;

        // Window behavior
        self.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary |
                                   NSWindowCollectionBehaviorIgnoresCycle;

        // Create the border view
        [self createBorderView];
    }

    return self;
}

- (void)createBorderView {
    // Create a view that will draw the border
    _borderView = [[NSView alloc] initWithFrame:self.contentView.bounds];
    _borderView.wantsLayer = YES;
    _borderView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    // Configure the layer to draw only the border (no fill)
    _borderView.layer.backgroundColor = [[NSColor clearColor] CGColor];
    _borderView.layer.borderColor = [_borderColor CGColor];
    _borderView.layer.borderWidth = 1.0;

    [self.contentView addSubview:_borderView];
}

- (void)updatePositionWithWordState:(WordPositionState)state {
    CGRect targetBounds;

    // Extract the appropriate bounds based on border type
    switch (_borderType) {
        case DebugBorderTypeWordWindow:
            targetBounds = state.windowBounds;
            break;

        case DebugBorderTypeScrollArea:
            targetBounds = state.scrollAreaBounds;
            break;

        case DebugBorderTypeLayout:
            // Use the actual layout container bounds from the accessibility tree
            targetBounds = CGRectMake(
                state.layoutPosition.x,
                state.layoutPosition.y,
                state.layoutSize.width,
                state.layoutSize.height
            );
            break;
    }

    // Update window frame to match the target bounds
    // Note: macOS uses bottom-left origin, so we need to flip Y coordinate
    NSRect screenFrame = [[NSScreen mainScreen] frame];
    CGRect flippedBounds = CGRectMake(
        targetBounds.origin.x,
        screenFrame.size.height - targetBounds.origin.y - targetBounds.size.height,
        targetBounds.size.width,
        targetBounds.size.height
    );

    [self setFrame:flippedBounds display:YES];
    [self show];
}

- (void)hide {
    if (_isVisible) {
        [self orderOut:nil];
        _isVisible = NO;
    }
}

- (void)show {
    if (!_isVisible) {
        [self orderFront:nil];
        _isVisible = YES;
    }
}

- (BOOL)isVisible {
    return _isVisible;
}

- (NSString*)overlayIdentifier {
    NSString* typeString;
    switch (_borderType) {
        case DebugBorderTypeWordWindow:
            typeString = @"WordWindow";
            break;
        case DebugBorderTypeScrollArea:
            typeString = @"ScrollArea";
            break;
        case DebugBorderTypeLayout:
            typeString = @"Layout";
            break;
    }
    return [NSString stringWithFormat:@"DebugBorder-%@", typeString];
}

@end
