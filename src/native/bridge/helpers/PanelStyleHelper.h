#import <Cocoa/Cocoa.h>

// PanelStyleHelper: Provides common NSPanel/NSWindow configuration presets
// Eliminates ~48 lines of configuration duplication across 4 window classes
@interface PanelStyleHelper : NSObject

// Configures panel as non-activating popup (doesn't steal focus from MS Word)
// Common settings:
// - clearColor background, non-opaque
// - Floating window level
// - Non-activating (becomesKeyOnlyIfNeeded = NO)
// - Works when modal
// - Stationary collection behavior
+ (void)configureAsNonActivatingPopup:(NSPanel*)panel
                         windowLevel:(NSWindowLevel)level
                           hasShadow:(BOOL)hasShadow
                          isOpaque:(BOOL)isOpaque;

// Configures panel as non-activating popup with default settings
// Uses NSFloatingWindowLevel + 1, no shadow, transparent
+ (void)configureAsNonActivatingPopup:(NSPanel*)panel;

@end
