#import "DebugInfoOverlay.h"
#import "../managers/AcademiaManager.h"

// Overlay dimensions
static const CGFloat kOverlayWidth = 350.0;
static const CGFloat kOverlayHeight = 180.0;
static const CGFloat kPadding = 10.0;
static const CGFloat kMarginFromEdge = 20.0;

@implementation DebugInfoOverlay {
    NSTextField* _titleLabel;
    NSTextField* _windowBoundsLabel;
    NSTextField* _scrollBoundsLabel;
    NSTextField* _layoutLabel;
    NSTextField* _layoutMarginLabel;
    NSTextField* _firstLineLabel;
    NSTextField* _visibleRangeLabel;
    BOOL _isVisible;
}

- (instancetype)init {
    // Position at bottom-right of screen
    NSRect screenFrame = [[NSScreen mainScreen] frame];
    NSRect overlayFrame = NSMakeRect(
        screenFrame.size.width - kOverlayWidth - kMarginFromEdge,  // Right edge
        kMarginFromEdge,  // Bottom edge
        kOverlayWidth,
        kOverlayHeight
    );

    self = [super initWithContentRect:overlayFrame
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];

    if (self) {
        _isVisible = NO;

        // Configure window appearance
        self.backgroundColor = [NSColor colorWithRed:0.1 green:0.1 blue:0.1 alpha:0.85];
        self.opaque = NO;
        self.level = NSFloatingWindowLevel + 2;  // Above other overlays
        self.ignoresMouseEvents = YES;  // Mouse events pass through
        self.hasShadow = YES;

        // Non-activating panel configuration
        self.floatingPanel = YES;
        self.becomesKeyOnlyIfNeeded = NO;
        self.worksWhenModal = YES;
        self.hidesOnDeactivate = NO;

        // Window behavior
        self.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary |
                                   NSWindowCollectionBehaviorIgnoresCycle;

        // Create the UI
        [self createLabels];
    }

    return self;
}

- (void)createLabels {
    CGFloat yOffset = kOverlayHeight - kPadding - 20;  // Start from top
    CGFloat lineHeight = 22.0;

    // Title label
    _titleLabel = [self createLabelAtY:yOffset withText:@"DEBUG INFO" fontSize:14 bold:YES];
    yOffset -= lineHeight;

    // Window bounds label
    _windowBoundsLabel = [self createLabelAtY:yOffset withText:@"Window: (loading...)" fontSize:11 bold:NO];
    yOffset -= lineHeight;

    // Scroll bounds label
    _scrollBoundsLabel = [self createLabelAtY:yOffset withText:@"Scroll: (loading...)" fontSize:11 bold:NO];
    yOffset -= lineHeight;

    // Layout bounds label (position + size)
    _layoutLabel = [self createLabelAtY:yOffset withText:@"Layout: (loading...)" fontSize:11 bold:NO];
    yOffset -= lineHeight;

    // Layout margin label
    _layoutMarginLabel = [self createLabelAtY:yOffset withText:@"Layout Margin: (loading...)" fontSize:11 bold:NO];
    yOffset -= lineHeight;

    // First line label
    _firstLineLabel = [self createLabelAtY:yOffset withText:@"First Line: (loading...)" fontSize:11 bold:NO];
    yOffset -= lineHeight;

    // Visible range label
    _visibleRangeLabel = [self createLabelAtY:yOffset withText:@"Visible Range: (loading...)" fontSize:11 bold:NO];
}

- (NSTextField*)createLabelAtY:(CGFloat)yPosition withText:(NSString*)text fontSize:(CGFloat)fontSize bold:(BOOL)bold {
    NSTextField* label = [[NSTextField alloc] initWithFrame:NSMakeRect(
        kPadding,
        yPosition,
        kOverlayWidth - (2 * kPadding),
        20
    )];

    label.stringValue = text;
    label.font = bold ? [NSFont boldSystemFontOfSize:fontSize] : [NSFont systemFontOfSize:fontSize];
    label.textColor = [NSColor whiteColor];
    label.backgroundColor = [NSColor clearColor];
    label.bordered = NO;
    label.editable = NO;
    label.selectable = NO;
    label.lineBreakMode = NSLineBreakByTruncatingTail;

    [self.contentView addSubview:label];
    return label;
}

- (void)updatePositionWithWordState:(WordPositionState)state {
    // Update window bounds label
    _windowBoundsLabel.stringValue = [NSString stringWithFormat:@"Window: (%.0f, %.0f) %.0fx%.0f",
        state.windowBounds.origin.x,
        state.windowBounds.origin.y,
        state.windowBounds.size.width,
        state.windowBounds.size.height];

    // Update scroll bounds label
    _scrollBoundsLabel.stringValue = [NSString stringWithFormat:@"Scroll: (%.0f, %.0f) %.0fx%.0f",
        state.scrollAreaBounds.origin.x,
        state.scrollAreaBounds.origin.y,
        state.scrollAreaBounds.size.width,
        state.scrollAreaBounds.size.height];

    // Update layout bounds label (position + size)
    _layoutLabel.stringValue = [NSString stringWithFormat:@"Layout: (%.0f, %.0f) %.0fx%.0f",
        state.layoutPosition.x,
        state.layoutPosition.y,
        state.layoutSize.width,
        state.layoutSize.height];

    // Update layout margin label
    _layoutMarginLabel.stringValue = [NSString stringWithFormat:@"Layout Margin: %.0f",
        state.layoutLeftMargin];

    // Update first line label
    _firstLineLabel.stringValue = [NSString stringWithFormat:@"First Line: (%.0f, %.0f) %.0fx%.0f",
        state.firstLinePosition.origin.x,
        state.firstLinePosition.origin.y,
        state.firstLinePosition.size.width,
        state.firstLinePosition.size.height];

    // Update visible range label
    _visibleRangeLabel.stringValue = [NSString stringWithFormat:@"Visible Range: %ld-%ld (len: %ld)",
        (long)state.visibleCharacterRange.location,
        (long)(state.visibleCharacterRange.location + state.visibleCharacterRange.length),
        (long)state.visibleCharacterRange.length];

    // Note: Position stays fixed at bottom-right, no need to move the overlay
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
    return @"DebugInfoOverlay";
}

@end
