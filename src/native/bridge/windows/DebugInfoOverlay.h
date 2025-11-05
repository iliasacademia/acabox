#import <Cocoa/Cocoa.h>
#import "../adapters/MicrosoftWordAdapter.h"
#import "../managers/AcademiaManager.h"

/**
 * DebugInfoOverlay displays Word position state information in a fixed overlay
 * at the bottom-right of the screen for debugging purposes.
 */
@interface DebugInfoOverlay : NSPanel <OverlayWindow>

/**
 * Initialize the debug info overlay.
 *
 * @return An initialized DebugInfoOverlay instance
 */
- (instancetype)init;

/**
 * Update the displayed information based on Word's current state.
 *
 * @param state The current Word position state
 */
- (void)updatePositionWithWordState:(WordPositionState)state;

/**
 * Hide the overlay.
 */
- (void)hide;

/**
 * Show the overlay.
 */
- (void)show;

/**
 * Check if the overlay is currently visible.
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
