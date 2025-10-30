#import <Cocoa/Cocoa.h>

// ResizeHandleView: A small view that provides a visible resize handle
// Features:
// - Positioned in the bottom-right corner of the window
// - Invisible by default, fades in on mouse hover
// - Allows diagonal resizing of the window
@interface ResizeHandleView : NSView

// Properties
@property (nonatomic, weak) NSWindow* windowToResize;
@property (nonatomic, assign) NSPoint dragStartLocation;
@property (nonatomic, assign) NSRect windowStartFrame;
@property (nonatomic, assign) BOOL isHovering;
@property (nonatomic, strong) NSTrackingArea* trackingArea;

// Initialization
- (instancetype)initWithFrame:(NSRect)frameRect window:(NSWindow*)window;

@end
