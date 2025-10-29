#import "BasePopupWindow.h"

// Forward declaration
@class ButtonOverlayWindow;

// TextPopupWindow: Popup window for showing selected text on hover using React via WKWebView
// Inherits from BasePopupWindow to leverage shared WKWebView setup, HTML loading, and message handling
@interface TextPopupWindow : BasePopupWindow

// Properties
@property (nonatomic, weak) ButtonOverlayWindow* buttonWindow;  // Parent button window
@property (nonatomic, strong) NSString* currentText;           // Currently displayed text
@property (nonatomic, assign) BOOL isProcessingClick;          // Flag to prevent popup close during button clicks
@property (nonatomic, strong) NSTrackingArea* trackingArea;    // Mouse tracking area

// Initialization
- (instancetype)initWithText:(NSString*)text;

// Content update
- (void)updateContentWithText:(NSString*)text;

// Mouse tracking
- (void)setupMouseTracking;
- (void)mouseEntered:(NSEvent *)event;
- (void)mouseExited:(NSEvent *)event;
- (void)mouseDown:(NSEvent *)event;
- (void)mouseMoved:(NSEvent *)event;

// Focus handling
- (BOOL)acceptsFirstResponder;
- (void)resignKeyWindow;

@end
