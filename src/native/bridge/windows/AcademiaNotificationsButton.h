#import <Cocoa/Cocoa.h>
#import "BasePopupWindow.h"
#import "AcademiaNotificationsPopup.h"
#import "../managers/AcademiaManager.h"

// Forward declaration
@class WordAccessibilityObserver;

// AcademiaNotificationsButton: WebView-based button showing "A" icon with notification badge
// Displays at bottom-left of scroll area, opens AcademiaNotificationsPopup on click
// Uses DraggableAcceptingWebView for rich content (button with badge)
@interface AcademiaNotificationsButton : BasePopupWindow <OverlayWindow>

// Properties
@property (nonatomic, strong) AcademiaNotificationsPopup* popup;  // Notifications popup window
@property (nonatomic, assign) BOOL popupWasVisible;  // Track if popup should be re-shown after Word state changes

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

// Popup management
- (void)showPopup;
- (void)hidePopup;

// Clipping/Masking for partial visibility
- (void)setVisibleRect:(NSRect)visibleRect inFrame:(NSRect)fullFrame;
- (void)clearVisibleRectMask;

// Cleanup
- (void)orderOut:(id)sender;

@end
