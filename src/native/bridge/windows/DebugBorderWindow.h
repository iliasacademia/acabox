#import <Cocoa/Cocoa.h>
#import "../adapters/MicrosoftWordAdapter.h"

// Border type enum to identify which bounds to track
typedef NS_ENUM(NSInteger, DebugBorderType) {
    DebugBorderTypeWordWindow,      // Red - tracks Word window bounds
    DebugBorderTypeScrollArea,      // Blue - tracks scroll area bounds
    DebugBorderTypeLayout           // Green - tracks layout container bounds
};

@protocol OverlayWindow;

/**
 * DebugBorderWindow draws a colored 1px border around different Word UI elements
 * for visual debugging. Each instance tracks a specific bounds type.
 */
@interface DebugBorderWindow : NSPanel <OverlayWindow>

/**
 * Initialize a debug border window with a specific type and color.
 *
 * @param borderType The type of bounds this window will track
 * @param color The NSColor to use for the border
 * @return An initialized DebugBorderWindow instance
 */
- (instancetype)initWithBorderType:(DebugBorderType)borderType color:(NSColor*)color;

/**
 * Update the border position based on Word's current state.
 * Automatically extracts the appropriate bounds based on borderType.
 *
 * @param state The current Word position state
 */
- (void)updatePositionWithWordState:(WordPositionState)state;

/**
 * Hide the border window.
 */
- (void)hide;

/**
 * Show the border window.
 */
- (void)show;

/**
 * Check if the border is currently visible.
 *
 * @return YES if visible, NO otherwise
 */
- (BOOL)isVisible;

/**
 * Get the identifier for this overlay.
 *
 * @return String identifier for logging
 */
- (NSString*)overlayIdentifier;

@end
