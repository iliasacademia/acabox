#import "BasePopupWindow.h"
#import "../views/ResizeHandleView.h"
#import "../managers/AcademiaManager.h"

// TextSidePopup: Citation suggestion popup shown below TextSideButton with React content
// Inherits from BasePopupWindow to leverage shared WKWebView setup, HTML loading, and message handling
@interface TextSidePopup : BasePopupWindow <NSWindowDelegate, OverlayWindow>

// Properties
@property (nonatomic, strong) NSString* citationData;         // Citation data JSON string
@property (nonatomic, strong) ResizeHandleView* resizeHandle; // Resize handle view

// Pending responses waiting for ACK from JavaScript
@property (nonatomic, strong) NSMutableDictionary* pendingResponses;  // Store responses waiting for ACK

// Position and size persistence
@property (nonatomic, assign) BOOL wasVisibleBeforeHiding;    // Track if window was visible before app deactivation
@property (nonatomic, assign) NSRect savedFrame;              // Stores last known position and size

// Initialization
- (instancetype)initWithObserver:(WordAccessibilityObserver*)observer;

// Content update
- (void)updateContentWithData:(NSString*)data;

@end
