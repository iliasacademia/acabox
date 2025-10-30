#import "BasePopupWindow.h"
#import "../views/NativeHeaderView.h"
#import "../views/ResizeHandleView.h"

// ClickPopupWindow: Click popup for detailed suggestions/information with React content
// Inherits from BasePopupWindow to leverage shared WKWebView setup, HTML loading, and message handling
@interface ClickPopupWindow : BasePopupWindow <NSWindowDelegate>

// Properties
@property (nonatomic, strong) NSString* currentData;      // Current data (for compatibility)
@property (nonatomic, assign) int count;                  // Count to display
@property (nonatomic, strong) NativeHeaderView* nativeHeader;  // Native header view for dragging
@property (nonatomic, strong) ResizeHandleView* resizeHandle;  // Resize handle view

// Position and size persistence
@property (nonatomic, assign) BOOL wasVisibleBeforeHiding;    // Track if window was visible before app deactivation
@property (nonatomic, assign) NSRect savedFrame;              // Stores last known position and size

// Initialization
- (instancetype)initWithCount:(int)count observer:(WordAccessibilityObserver*)observer;

// Content update
- (void)updateContentWithCount:(int)count;

@end
