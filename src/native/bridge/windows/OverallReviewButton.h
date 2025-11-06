#import <Cocoa/Cocoa.h>
#import "BasePopupWindow.h"
#import "OverallReviewPopup.h"
#import "../managers/AcademiaManager.h"

// Forward declaration
@class WordAccessibilityObserver;

// OverallReviewButton: WebView-based pill-shaped button showing "Overall review | Date"
// Displays at top-left of first line, opens OverallReviewPopup on click
// Uses DraggableAcceptingWebView for rich content (logo, text, date, icons)
@interface OverallReviewButton : BasePopupWindow <OverlayWindow>

// Properties
@property (nonatomic, strong) OverallReviewPopup* clickPopup;
@property (nonatomic, copy) NSString* currentDate;

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

// Content update
- (void)updateDate:(NSString*)date;

// Popup management
- (void)showClickPopup;
- (void)hideClickPopup;

// Clipping/Masking for partial visibility
- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame;
- (void)clearVisibleRectMask;

// Cleanup
- (void)orderOut:(id)sender;

@end
