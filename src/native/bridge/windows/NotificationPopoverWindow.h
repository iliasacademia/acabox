#import "BasePopupWindow.h"

// Forward declaration
@class ButtonOverlayWindow;

// NotificationPopoverWindow: Popup window for displaying notifications when Academia button is clicked
// Inherits from BasePopupWindow to leverage shared WKWebView setup, HTML loading, and message handling
@interface NotificationPopoverWindow : BasePopupWindow

// Properties
@property (nonatomic, weak) ButtonOverlayWindow* buttonWindow;  // Parent button window

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

// Content update
- (void)updateContent;

@end
