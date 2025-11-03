#import <Cocoa/Cocoa.h>

// Forward declaration
@class WordAccessibilityObserver;
@class TextPopupWindow;

// ButtonOverlayWindow: Native button overlay window showing "A" button on selection
@interface ButtonOverlayWindow : NSPanel

// Properties
@property (nonatomic, weak) WordAccessibilityObserver* observer;
@property (nonatomic, strong) NSButton* button;
@property (nonatomic, strong) TextPopupWindow* popupWindow;  // Keep for destroyPopup cleanup
@property (nonatomic, strong) NSString* selectedText;
@property (nonatomic, assign) CGRect selectionBounds;  // Store selection bounds for popup positioning
@property (nonatomic, strong) NSView* badgeView;  // Red badge indicator for notifications
@property (nonatomic, strong) NSTextField* badgeLabel;  // Label showing notification count
@property (nonatomic, assign) int badgeCount;  // Current badge count (for debugging)

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

// Popup management
- (void)destroyPopup;

// Button action
- (void)buttonClicked:(id)sender;

// Positioning
- (void)positionAtPoint:(CGPoint)point withHeight:(CGFloat)selectionHeight;

// Clipping/Masking for partial visibility
- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame;
- (void)clearVisibleRectMask;

// Badge management
- (void)updateBadge:(int)count;
- (int)getBadgeCount;
- (CGRect)getBadgeFrame;

// Cleanup
- (void)orderOut:(id)sender;

@end
