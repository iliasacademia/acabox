#import "BasePopupWindow.h"

// ClickPopupWindow: Click popup for detailed suggestions/information with React content
// Inherits from BasePopupWindow to leverage shared WKWebView setup, HTML loading, and message handling
@interface ClickPopupWindow : BasePopupWindow

// Properties
@property (nonatomic, strong) NSString* currentData;      // Current data (for compatibility)
@property (nonatomic, assign) int count;                  // Count to display
@property (nonatomic, strong) id globalMouseMonitor;      // Global mouse monitor for outside-click detection

// Initialization
- (instancetype)initWithCount:(int)count observer:(WordAccessibilityObserver*)observer;

// Content update
- (void)updateContentWithCount:(int)count;

// Mouse monitoring for outside clicks
- (void)startGlobalMouseMonitor;
- (void)stopGlobalMouseMonitor;

@end
