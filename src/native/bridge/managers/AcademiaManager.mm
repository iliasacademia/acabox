//
//  AcademiaManager.mm
//  AcademiaElectron
//
//  Implementation of Academia overlay coordinator
//

#import "AcademiaManager.h"

@implementation AcademiaManager {
    // Registry of overlay windows (using NSHashTable for weak references)
    NSHashTable<id<OverlayWindow>> *_overlays;

    // State tracking
    BOOL _isChanging;  // Whether Word is currently changing state
}

#pragma mark - Initialization

- (instancetype)initWithWordAdapter:(MicrosoftWordAdapter *)adapter {
    self = [super init];
    if (self) {
        _wordAdapter = adapter;
        _isManaging = NO;
        _badgeCount = 0;
        _isChanging = NO;

        // Create weak hash table for overlays (won't retain them)
        _overlays = [NSHashTable weakObjectsHashTable];

        NSLog(@"[AcademiaManager] Initialized with Word adapter (PID: %d)", adapter.wordPID);
    }
    return self;
}

- (void)dealloc {
    NSLog(@"[AcademiaManager] Deallocating manager");
    [self stopManaging];
}

#pragma mark - Management Control

- (BOOL)startManaging {
    if (_isManaging) {
        NSLog(@"[AcademiaManager] Already managing overlays");
        return YES;
    }

    if (!_wordAdapter) {
        NSLog(@"[AcademiaManager] ERROR: No word adapter available");
        return NO;
    }

    // Set ourselves as delegate of word adapter
    _wordAdapter.delegate = self;

    // Start observing if not already
    if (!_wordAdapter.isObserving) {
        NSError *error = nil;
        if (![_wordAdapter startObserving:&error]) {
            NSLog(@"[AcademiaManager] ERROR: Failed to start word adapter: %@", error.localizedDescription);
            return NO;
        }
    }

    _isManaging = YES;
    NSLog(@"[AcademiaManager] Started managing %lu overlays", (unsigned long)[self registeredOverlayCount]);

    // Initial position calculation
    [self recalculateAllPositions];

    return YES;
}

- (void)stopManaging {
    if (!_isManaging) {
        return;
    }

    NSLog(@"[AcademiaManager] Stopping management of overlays");

    // Remove ourselves as delegate
    if (_wordAdapter.delegate == self) {
        _wordAdapter.delegate = nil;
    }

    // Hide all overlays
    [self hideAllOverlays];

    _isManaging = NO;
}

#pragma mark - Overlay Registration

- (void)registerOverlay:(id<OverlayWindow>)overlay {
    if (!overlay) {
        NSLog(@"[AcademiaManager] WARNING: Attempted to register nil overlay");
        return;
    }

    [_overlays addObject:overlay];

    NSString *identifier = @"Unknown";
    if ([overlay respondsToSelector:@selector(overlayIdentifier)]) {
        identifier = [overlay overlayIdentifier];
    }

    NSLog(@"[AcademiaManager] Registered overlay: %@ (total: %lu)",
          identifier, (unsigned long)[self registeredOverlayCount]);

    // If already managing, update this overlay's position
    if (_isManaging && !_isChanging) {
        WordPositionState state = [_wordAdapter getCurrentState];
        [overlay updatePositionWithWordState:state];
    }

    // Update badge if this overlay supports it
    if ([overlay respondsToSelector:@selector(updateBadgeCount:)]) {
        [overlay updateBadgeCount:_badgeCount];
    }
}

- (void)unregisterOverlay:(id<OverlayWindow>)overlay {
    if (!overlay) {
        return;
    }

    NSString *identifier = @"Unknown";
    if ([overlay respondsToSelector:@selector(overlayIdentifier)]) {
        identifier = [overlay overlayIdentifier];
    }

    [_overlays removeObject:overlay];

    NSLog(@"[AcademiaManager] Unregistered overlay: %@ (remaining: %lu)",
          identifier, (unsigned long)[self registeredOverlayCount]);
}

- (void)unregisterAllOverlays {
    NSLog(@"[AcademiaManager] Unregistering all %lu overlays", (unsigned long)[self registeredOverlayCount]);
    [_overlays removeAllObjects];
}

- (NSUInteger)registeredOverlayCount {
    return _overlays.count;
}

#pragma mark - Overlay Control

- (void)updateBadgeCount:(NSInteger)count {
    if (_badgeCount == count) {
        return;  // No change
    }

    NSLog(@"[AcademiaManager] Updating badge count: %ld -> %ld", (long)_badgeCount, (long)count);
    _badgeCount = count;

    // Propagate to all badge-capable overlays
    NSUInteger updatedCount = 0;
    for (id<OverlayWindow> overlay in _overlays) {
        if ([overlay respondsToSelector:@selector(updateBadgeCount:)]) {
            [overlay updateBadgeCount:count];
            updatedCount++;
        }
    }

    NSLog(@"[AcademiaManager] Updated badge count on %lu overlays", (unsigned long)updatedCount);
}

- (void)hideAllOverlays {
    NSLog(@"[AcademiaManager] Hiding all %lu overlays", (unsigned long)[self registeredOverlayCount]);

    NSUInteger hiddenCount = 0;
    for (id<OverlayWindow> overlay in _overlays) {
        if ([overlay isVisible]) {
            [overlay hide];
            hiddenCount++;
        }
    }

    NSLog(@"[AcademiaManager] Hid %lu overlays", (unsigned long)hiddenCount);
}

- (void)showAllOverlays {
    if (!_isManaging) {
        NSLog(@"[AcademiaManager] WARNING: Not managing, cannot show overlays");
        return;
    }

    NSLog(@"[AcademiaManager] Showing all overlays (after recalculating positions)");

    // First recalculate positions
    [self recalculateAllPositions];

    // Then show each overlay
    NSUInteger shownCount = 0;
    for (id<OverlayWindow> overlay in _overlays) {
        if (![overlay isVisible]) {
            [overlay show];
            shownCount++;
        }
    }

    NSLog(@"[AcademiaManager] Showed %lu overlays", (unsigned long)shownCount);
}

- (void)recalculateAllPositions {
    if (!_wordAdapter) {
        NSLog(@"[AcademiaManager] WARNING: No word adapter, cannot recalculate positions");
        return;
    }

    WordPositionState state = [_wordAdapter getCurrentState];

    NSLog(@"[AcademiaManager] Recalculating positions for %lu overlays", (unsigned long)[self registeredOverlayCount]);
    NSLog(@"[AcademiaManager] Word state - window: (%.1f, %.1f, %.1f, %.1f), scroll: (%.1f, %.1f, %.1f, %.1f), layout: (%.1f, %.1f, %.1f, %.1f)",
          state.windowBounds.origin.x, state.windowBounds.origin.y,
          state.windowBounds.size.width, state.windowBounds.size.height,
          state.scrollAreaBounds.origin.x, state.scrollAreaBounds.origin.y,
          state.scrollAreaBounds.size.width, state.scrollAreaBounds.size.height,
          state.layoutPosition.x, state.layoutPosition.y,
          state.layoutSize.width, state.layoutSize.height);

    for (id<OverlayWindow> overlay in _overlays) {
        [overlay updatePositionWithWordState:state];
    }
}

#pragma mark - State Query

- (BOOL)hasVisibleOverlays {
    for (id<OverlayWindow> overlay in _overlays) {
        if ([overlay isVisible]) {
            return YES;
        }
    }
    return NO;
}

- (NSArray<NSString *> *)visibleOverlayIdentifiers {
    NSMutableArray<NSString *> *identifiers = [NSMutableArray array];

    for (id<OverlayWindow> overlay in _overlays) {
        if ([overlay isVisible]) {
            NSString *identifier = @"Unknown";
            if ([overlay respondsToSelector:@selector(overlayIdentifier)]) {
                identifier = [overlay overlayIdentifier];
            }
            [identifiers addObject:identifier];
        }
    }

    return [identifiers copy];
}

#pragma mark - MicrosoftWordAdapterDelegate

- (void)wordAdapterDidStartChanging:(id)adapter {
    NSLog(@"[AcademiaManager] ===== Word Change START =====");
    _isChanging = YES;

    // Hide all overlays immediately when Word starts changing
    [self hideAllOverlays];
}

- (void)wordAdapterDidCompleteChanging:(id)adapter withState:(WordPositionState)state {
    NSLog(@"[AcademiaManager] ===== Word Change COMPLETE =====");
    _isChanging = NO;

    // Recalculate positions with new state
    NSLog(@"[AcademiaManager] Updating %lu overlays with new Word state", (unsigned long)[self registeredOverlayCount]);

    for (id<OverlayWindow> overlay in _overlays) {
        // Update position - each overlay handles its own show/hide logic
        [overlay updatePositionWithWordState:state];
    }

    NSLog(@"[AcademiaManager] Overlay positions updated and shown");
}

- (void)wordAdapterDidActivate:(id)adapter {
    NSLog(@"[AcademiaManager] Word activated - showing overlays");

    // Show all overlays when Word becomes active
    [self showAllOverlays];
}

- (void)wordAdapterDidDeactivate:(id)adapter {
    NSLog(@"[AcademiaManager] Word deactivated - hiding overlays");

    // Hide all overlays when Word is deactivated
    [self hideAllOverlays];
}

#pragma mark - Debug Helpers

- (NSString *)description {
    return [NSString stringWithFormat:@"<AcademiaManager: managing=%d, overlays=%lu, badgeCount=%ld, changing=%d>",
            _isManaging,
            (unsigned long)[self registeredOverlayCount],
            (long)_badgeCount,
            _isChanging];
}

@end
