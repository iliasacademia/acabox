//
//  MicrosoftWordAdapter.h
//  AcademiaElectron
//
//  Single-responsibility adapter for tracking Microsoft Word window/scroll/document positions
//  Emits change_start and change_complete events with debouncing
//

#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Event types emitted by MicrosoftWordAdapter
 */
typedef NS_ENUM(NSInteger, WordAdapterEventType) {
    WordAdapterEventChangeStart,    // Word state change began (scroll, move, resize)
    WordAdapterEventChangeComplete, // Word state change completed (debounced)
    WordAdapterEventAppActivated,   // Word became active app
    WordAdapterEventAppDeactivated  // Word is no longer active app
};

/**
 * Structure representing Word window/document position state
 */
typedef struct {
    CGRect windowBounds;           // Word window position/size
    CGRect scrollAreaBounds;       // Scroll area bounds
    CGPoint layoutPosition;        // Layout container's top-left corner position
    CGSize layoutSize;             // Layout container's size
    CGFloat layoutLeftMargin;      // Layout left margin
    CGRect firstLinePosition;      // Position of first line in document
    CFRange visibleCharacterRange; // Currently visible text range
    BOOL isPageCornerVisible;      // Whether page corner (char 0) is visible
} WordPositionState;

/**
 * Delegate protocol for receiving Word state change events
 */
@protocol MicrosoftWordAdapterDelegate <NSObject>

/**
 * Called when Word state change begins (scroll, move, resize)
 * Listeners should typically hide UI overlays on this event
 */
- (void)wordAdapterDidStartChanging:(id)adapter;

/**
 * Called when Word state change completes (debounced after 300-500ms)
 * Listeners should recalculate positions and show UI overlays on this event
 *
 * @param state The current Word position state after change completed
 */
- (void)wordAdapterDidCompleteChanging:(id)adapter withState:(WordPositionState)state;

@optional

/**
 * Called when Word becomes the active application
 */
- (void)wordAdapterDidActivate:(id)adapter;

/**
 * Called when Word is no longer the active application
 */
- (void)wordAdapterDidDeactivate:(id)adapter;

@end

/**
 * MicrosoftWordAdapter
 *
 * Single-responsibility class for tracking MS Word window/scroll/document positions.
 * Consolidates position queries, AX observers, scroll monitoring, and debouncing logic.
 *
 * Key Benefits:
 * - Testable: Can mock AX API calls
 * - Cacheable: Position data cached for performance
 * - Reusable: Can be used by multiple features
 * - Focused: No UI concerns, pure state tracking
 *
 * Usage:
 *   adapter = [[MicrosoftWordAdapter alloc] initWithPID:pid delegate:self];
 *   [adapter startObserving:&error];
 *   // Implement delegate methods to receive events
 *   [adapter stopObserving];
 */
@interface MicrosoftWordAdapter : NSObject

/**
 * Delegate that receives state change events
 */
@property (nonatomic, weak, nullable) id<MicrosoftWordAdapterDelegate> delegate;

/**
 * Process ID of Microsoft Word application
 */
@property (nonatomic, readonly) pid_t wordPID;

/**
 * Whether the adapter is currently observing Word
 */
@property (nonatomic, readonly) BOOL isObserving;

/**
 * Enable verbose logging for getLayoutBounds function
 * When enabled, logs every step of the accessibility hierarchy walk
 * Default: NO
 */
@property (nonatomic) BOOL enableGetLayoutBoundsLogging;

/**
 * Initialize adapter for a specific Word process
 *
 * @param pid Process ID of Microsoft Word
 * @param delegate Delegate to receive state change events
 * @return Initialized adapter instance
 */
- (instancetype)initWithPID:(pid_t)pid delegate:(nullable id<MicrosoftWordAdapterDelegate>)delegate;

/**
 * Start observing Word for position/state changes
 * Registers AX observers and starts monitoring
 *
 * @param error Error pointer for failure details
 * @return YES if observation started successfully, NO on failure
 */
- (BOOL)startObserving:(NSError *_Nullable *_Nullable)error;

/**
 * Stop observing Word and clean up resources
 * Unregisters observers and invalidates timers
 */
- (void)stopObserving;

/**
 * Check if accessibility permission is granted
 *
 * @return YES if permission granted, NO otherwise
 */
- (BOOL)checkAccessibilityPermission;

#pragma mark - Position Query Methods (Cached for Performance)

/**
 * Get Word window bounds (position + size)
 * Result is cached and updated on window move/resize events
 *
 * @return CGRect representing window bounds, or CGRectZero on error
 */
- (CGRect)getWordWindowBounds;

/**
 * Get scroll area bounds within Word window
 * Result is cached briefly for performance
 *
 * @return CGRect representing scroll area bounds, or CGRectZero on error
 */
- (CGRect)getScrollAreaBounds;

/**
 * Get layout container bounds (position and size)
 * The layout container is the element 2 levels up from AXTextArea
 * Used for positioning overlays and scroll detection
 *
 * @return CGRect representing layout bounds, or CGRectZero on error
 */
- (CGRect)getLayoutBounds;

/**
 * Get layout container's left margin position
 *
 * @return CGFloat representing left margin x-coordinate
 */
- (CGFloat)getLayoutLeftMargin;

/**
 * Get position of first line in document
 *
 * @return CGRect representing first line bounds, or CGRectZero on error
 */
- (CGRect)getFirstLinePosition;

/**
 * Find position of specified text in the document
 * Searches for the text in the currently focused text area and returns its bounding rectangle
 *
 * @param searchText The text to search for
 * @return CGRect representing text bounds in screen coordinates, or CGRectZero if not found
 */
- (CGRect)findTextPosition:(NSString*)searchText;

/**
 * Get currently visible character range in document
 *
 * @return CFRange representing visible text range
 */
- (CFRange)getVisibleCharacterRange;

/**
 * Check if page corner (character 0) is visible in viewport
 *
 * @return YES if page corner is visible, NO otherwise
 */
- (BOOL)isPageCornerVisible;

/**
 * Get complete position state snapshot
 * Useful for getting all position data at once
 *
 * @return WordPositionState struct with all position data
 */
- (WordPositionState)getCurrentState;

#pragma mark - Cache Management

/**
 * Invalidate position caches
 * Forces fresh AX API queries on next access
 * Useful when Word window state changes externally
 */
- (void)invalidateCaches;

/**
 * Update cached Word window bounds immediately
 * Called internally on window move/resize events
 */
- (void)updateCachedWordBounds;

/**
 * Get the document path from the active (frontmost) window
 *
 * @return NSString path to the document file, or nil if not found
 */
- (NSString* _Nullable)getActiveDocumentPath;

@end

NS_ASSUME_NONNULL_END
