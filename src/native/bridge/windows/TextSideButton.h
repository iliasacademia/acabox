#import <Cocoa/Cocoa.h>
#import "BasePopupWindow.h"
#import "TextSidePopup.h"
#import "../managers/AcademiaManager.h"
#import "../adapters/MicrosoftWordAdapter.h"

// Forward declaration
@class WordAccessibilityObserver;

// TextSideButton: WebView-based button that positions itself next to specific text in Word document
// Searches for specified text and displays button adjacent to it when text is visible
// Automatically repositions when document scrolls or window moves
@interface TextSideButton : BasePopupWindow <OverlayWindow>

// Properties
@property (nonatomic, copy) NSString* searchText;
@property (nonatomic, strong) TextSidePopup* clickPopup;

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer searchText:(NSString*)text;

// Popup management
- (void)showClickPopup;

// Cleanup
- (void)orderOut:(id)sender;

@end
