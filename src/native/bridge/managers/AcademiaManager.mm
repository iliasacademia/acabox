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
    }
    return self;
}

- (void)dealloc {
    [self stopManaging];
}

#pragma mark - Management Control

- (BOOL)startManaging {
    if (_isManaging) {
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

    // Initial position calculation
    [self recalculateAllPositions];

    return YES;
}

- (void)stopManaging {
    if (!_isManaging) {
        return;
    }

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

    [_overlays removeObject:overlay];
}

- (void)unregisterAllOverlays {
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

    _badgeCount = count;

    // Propagate to all badge-capable overlays
    for (id<OverlayWindow> overlay in _overlays) {
        if ([overlay respondsToSelector:@selector(updateBadgeCount:)]) {
            [overlay updateBadgeCount:count];
        }
    }
}

- (void)hideAllOverlays {
    for (id<OverlayWindow> overlay in _overlays) {
        if ([overlay isVisible]) {
            [overlay hide];
        }
    }
}

- (void)showAllOverlays {
    if (!_isManaging) {
        NSLog(@"[AcademiaManager] WARNING: Not managing, cannot show overlays");
        return;
    }

    // First recalculate positions
    [self recalculateAllPositions];

    // Then show each overlay
    for (id<OverlayWindow> overlay in _overlays) {
        if (![overlay isVisible]) {
            [overlay show];
        }
    }
}

- (void)recalculateAllPositions {
    if (!_wordAdapter) {
        NSLog(@"[AcademiaManager] WARNING: No word adapter, cannot recalculate positions");
        return;
    }

    WordPositionState state = [_wordAdapter getCurrentState];

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
    _isChanging = YES;

    // Hide all overlays immediately when Word starts changing
    [self hideAllOverlays];
}

- (void)wordAdapterDidCompleteChanging:(id)adapter withState:(WordPositionState)state {
    _isChanging = NO;

    // Recalculate positions with new state
    for (id<OverlayWindow> overlay in _overlays) {
        // Update position - each overlay will decide whether to show/hide itself
        [overlay updatePositionWithWordState:state];
    }
}

- (void)wordAdapterDidActivate:(id)adapter {
    // Show all overlays when Word becomes active
    [self showAllOverlays];
}

- (void)wordAdapterDidDeactivate:(id)adapter {
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
