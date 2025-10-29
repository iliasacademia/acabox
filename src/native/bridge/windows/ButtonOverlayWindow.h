#import <Cocoa/Cocoa.h>
#import "TextPopupWindow.h"

// Forward declaration
@class WordAccessibilityObserver;

// ButtonOverlayWindow: Native button overlay window showing "A" button on selection
// Manages TextPopupWindow as a child for hover behavior
@interface ButtonOverlayWindow : NSPanel

// Properties
@property (nonatomic, weak) WordAccessibilityObserver* observer;
@property (nonatomic, strong) NSButton* button;
@property (nonatomic, strong) NSTrackingArea* trackingArea;
@property (nonatomic, strong) TextPopupWindow* popupWindow;
@property (nonatomic, strong) NSString* selectedText;
@property (nonatomic, copy) dispatch_block_t scheduledHideBlock;
@property (nonatomic, assign) CGRect selectionBounds;  // Store selection bounds for popup positioning

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

// Mouse tracking
- (void)setupMouseTracking;
- (void)mouseEntered:(NSEvent *)event;
- (void)mouseExited:(NSEvent *)event;

// Popup management
- (void)showPopup;
- (void)hidePopup;
- (void)scheduleHidePopup;
- (void)cancelScheduledHide;
- (void)destroyPopup;

// Button action
- (void)buttonClicked:(id)sender;

// Positioning
- (void)positionAtPoint:(CGPoint)point withHeight:(CGFloat)selectionHeight;

// Clipping/Masking for partial visibility
- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame;
- (void)clearVisibleRectMask;

// Cleanup
- (void)orderOut:(id)sender;

@end
