#import <Cocoa/Cocoa.h>

// Forward declaration
@class WordAccessibilityObserver;

// BaseNativeWindow: Abstract base class for native (non-WebView) popup windows
// Provides common functionality for ButtonOverlayWindow and LineCountButtonWindow
// Centralizes:
// - NSPanel configuration (non-activating, floating)
// - Mouse tracking setup
// - Focus management
@interface BaseNativeWindow : NSPanel

// Properties
@property (nonatomic, weak) WordAccessibilityObserver* observer;  // Weak to avoid retain cycles
@property (nonatomic, strong) NSTrackingArea* trackingArea;

// Initialization
// Subclasses should call this in their init methods
- (instancetype)initWithSize:(CGSize)size
                windowLevel:(NSWindowLevel)level
                   observer:(WordAccessibilityObserver*)observer;

// Mouse tracking setup
// Subclasses can override to customize tracking behavior
- (void)setupMouseTracking;

// Focus management
- (BOOL)canBecomeKeyWindow;
- (BOOL)canBecomeMainWindow;

@end
