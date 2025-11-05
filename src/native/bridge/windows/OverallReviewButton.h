#import <Cocoa/Cocoa.h>
#import "OverallReviewPopup.h"
#import "../managers/AcademiaManager.h"

// Forward declaration
@class WordAccessibilityObserver;

// OverallReviewButton: Shows review count on left of first line
// Circular button with count, shows hover popup and click popup
@interface OverallReviewButton : NSPanel <OverlayWindow>

// Properties
@property (nonatomic, weak) WordAccessibilityObserver* observer;
@property (nonatomic, strong) NSTextField* countLabel;
@property (nonatomic, strong) NSTrackingArea* trackingArea;
@property (nonatomic, strong) NSTrackingArea* popupTrackingArea;
@property (nonatomic, strong) NSPanel* hoverPopup;
@property (nonatomic, strong) OverallReviewPopup* clickPopup;
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
