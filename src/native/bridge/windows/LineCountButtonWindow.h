#import <Cocoa/Cocoa.h>
#import "ClickPopupWindow.h"

// Forward declaration
@class WordAccessibilityObserver;

// LineCountButtonWindow: Shows line count on left of first line
// Circular button with count, shows hover popup and click popup
@interface LineCountButtonWindow : NSPanel

// Properties
@property (nonatomic, weak) WordAccessibilityObserver* observer;
@property (nonatomic, strong) NSTextField* countLabel;
@property (nonatomic, strong) NSTrackingArea* trackingArea;
@property (nonatomic, strong) NSPanel* hoverPopup;
@property (nonatomic, strong) ClickPopupWindow* clickPopup;
@property (nonatomic, copy) dispatch_block_t scheduledHideBlock;
@property (nonatomic, assign) int count;

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

// Mouse tracking
- (void)setupMouseTracking;
- (void)mouseEntered:(NSEvent *)event;
- (void)mouseExited:(NSEvent *)event;
- (void)mouseDown:(NSEvent *)event;

// Count update
- (void)updateCount:(int)count;

// Popup management
- (void)showHoverPopup;
- (void)hideHoverPopup;
- (void)showClickPopup;
- (void)hideClickPopup;
- (void)scheduleHidePopup;
- (void)cancelScheduledHide;

// Clipping/Masking for partial visibility
- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame;
- (void)clearVisibleRectMask;

// Cleanup
- (void)orderOut:(id)sender;

// Window behavior
- (BOOL)canBecomeKeyWindow;
- (BOOL)canBecomeMainWindow;

@end
