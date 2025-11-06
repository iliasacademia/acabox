#import "BasePopupWindow.h"
#import "../managers/AcademiaManager.h"

// Forward declaration
@class AcademiaNotificationsButton;

// AcademiaNotificationsPopup: Popup window for displaying notifications when Academia button is clicked
// Inherits from BasePopupWindow to leverage shared WKWebView setup, HTML loading, and message handling
@interface AcademiaNotificationsPopup : BasePopupWindow <OverlayWindow>

// Properties
@property (nonatomic, weak) AcademiaNotificationsButton* buttonWindow;  // Parent button window

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

@end
