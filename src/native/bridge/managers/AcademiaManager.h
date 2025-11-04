//
//  AcademiaManager.h
//  AcademiaElectron
//
//  Central coordinator for Academia overlay visibility and positioning
//  Single source of truth for overlay state management
//

#import <Foundation/Foundation.h>
#import <Cocoa/Cocoa.h>
#import "../adapters/MicrosoftWordAdapter.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * Protocol that all overlay windows must implement
 * Provides uniform interface for visibility and positioning control
 */
@protocol OverlayWindow <NSObject>

@required

/**
 * Update the overlay's position based on Word state
 * Called when Word state changes complete (after debouncing)
 *
 * @param state Current Word position state
 */
- (void)updatePositionWithWordState:(WordPositionState)state;

/**
 * Hide the overlay immediately
 * Called when Word state changes start (scroll, move, resize)
 */
- (void)hide;

/**
 * Show the overlay
 * Called after position has been updated
 */
- (void)show;

/**
 * Check if the overlay is currently visible
 *
 * @return YES if visible, NO otherwise
 */
- (BOOL)isVisible;

@optional

/**
 * Update badge count on the overlay
 * Only relevant for overlays that show badges (notifications, etc.)
 *
 * @param count Badge count to display
 */
- (void)updateBadgeCount:(NSInteger)count;

/**
 * Unique identifier for this overlay (for logging/debugging)
 *
 * @return String identifier (e.g., "NotificationsButton", "OverallReviewButton")
 */
- (NSString *)overlayIdentifier;

@end

/**
 * AcademiaManager
 *
 * Central coordinator for all Academia overlays on Microsoft Word.
 * Provides single source of truth for visibility control and positioning.
 *
 * Key Responsibilities:
 * - Register/unregister overlay windows
 * - Listen to MicrosoftWordAdapter state changes
 * - Hide all overlays when Word state changes begin (scroll, move, resize)
 * - Recalculate positions and show overlays when changes complete
 * - Manage badge count propagation to all badge-capable overlays
 *
 * Benefits:
 * - Single point of control eliminates scattered show/hide calls
 * - Clear state machine: changing → stable
 * - Easier debugging: all overlay decisions go through one place
 * - Testable: can mock adapter and verify overlay coordination
 *
 * Usage:
 *   adapter = [[MicrosoftWordAdapter alloc] initWithPID:wordPID delegate:nil];
 *   manager = [[AcademiaManager alloc] initWithWordAdapter:adapter];
 *
 *   // Register overlays
 *   [manager registerOverlay:notificationsButton];
 *   [manager registerOverlay:overallReviewButton];
 *
 *   // Start coordination
 *   [manager startManaging];
 *
 *   // Update badge count
 *   [manager updateBadgeCount:5];
 *
 *   // Clean up
 *   [manager stopManaging];
 */
@interface AcademiaManager : NSObject <MicrosoftWordAdapterDelegate>

/**
 * Word adapter this manager listens to
 */
@property (nonatomic, strong, readonly) MicrosoftWordAdapter *wordAdapter;

/**
 * Whether the manager is currently managing overlays
 */
@property (nonatomic, readonly) BOOL isManaging;

/**
 * Current badge count (propagated to all badge-capable overlays)
 */
@property (nonatomic, assign) NSInteger badgeCount;

/**
 * Initialize manager with a Word adapter
 *
 * @param adapter MicrosoftWordAdapter to listen to for state changes
 * @return Initialized manager instance
 */
- (instancetype)initWithWordAdapter:(MicrosoftWordAdapter *)adapter;

/**
 * Start managing overlays
 * Registers as delegate of word adapter and begins coordination
 *
 * @return YES if started successfully, NO on failure
 */
- (BOOL)startManaging;

/**
 * Stop managing overlays
 * Unregisters from word adapter and stops coordination
 */
- (void)stopManaging;

#pragma mark - Overlay Registration

/**
 * Register an overlay window for management
 * The overlay will receive position updates and visibility control
 *
 * @param overlay Window conforming to OverlayWindow protocol
 */
- (void)registerOverlay:(id<OverlayWindow>)overlay;

/**
 * Unregister an overlay window
 * The overlay will no longer receive updates from this manager
 *
 * @param overlay Window to unregister
 */
- (void)unregisterOverlay:(id<OverlayWindow>)overlay;

/**
 * Unregister all overlay windows
 * Useful for cleanup
 */
- (void)unregisterAllOverlays;

/**
 * Get count of registered overlays
 *
 * @return Number of currently registered overlays
 */
- (NSUInteger)registeredOverlayCount;

#pragma mark - Overlay Control

/**
 * Update badge count and propagate to all badge-capable overlays
 *
 * @param count New badge count
 */
- (void)updateBadgeCount:(NSInteger)count;

/**
 * Manually hide all overlays
 * Useful for app deactivation or other events
 */
- (void)hideAllOverlays;

/**
 * Manually show all overlays
 * Recalculates positions using current Word state
 */
- (void)showAllOverlays;

/**
 * Manually trigger position recalculation for all overlays
 * Uses current Word state from adapter
 */
- (void)recalculateAllPositions;

#pragma mark - State Query

/**
 * Check if any overlay is currently visible
 *
 * @return YES if at least one overlay is visible, NO otherwise
 */
- (BOOL)hasVisibleOverlays;

/**
 * Get list of currently visible overlay identifiers
 * Useful for debugging
 *
 * @return Array of NSString identifiers of visible overlays
 */
- (NSArray<NSString *> *)visibleOverlayIdentifiers;

@end

NS_ASSUME_NONNULL_END
