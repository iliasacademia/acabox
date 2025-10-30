#import <Cocoa/Cocoa.h>

// NativeHeaderView: Native macOS header view for ClickPopupWindow
// Provides draggable header with title, count badge, and close button
// Replaces React header component for native window dragging
@interface NativeHeaderView : NSView

// Display properties
@property (nonatomic, copy) NSString* titleText;      // Header title text
@property (nonatomic, assign) int badgeCount;         // Count displayed in badge

// Close button callback
@property (nonatomic, weak) id target;                // Target for close action
@property (nonatomic, assign) SEL closeAction;        // Selector to call on close

// Window management
@property (nonatomic, weak) NSWindow* windowToMove;   // Window to drag

// Drag state (internal)
@property (nonatomic, assign) NSPoint dragStartLocation;   // Initial mouse location
@property (nonatomic, assign) NSPoint windowStartOrigin;   // Initial window position
@property (nonatomic, assign) BOOL isHoveringCloseButton; // Close button hover state

// Initialization
- (instancetype)initWithFrame:(NSRect)frame window:(NSWindow*)window;

// Update methods
- (void)updateBadgeCount:(int)count;

@end
