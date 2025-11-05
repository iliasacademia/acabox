//
//  MicrosoftWordAdapter.mm
//  AcademiaElectron
//
//  Implementation of Microsoft Word position tracking adapter
//

#import "MicrosoftWordAdapter.h"

// Configuration constants
static const NSTimeInterval kScrollDebounceInterval = 0.4;      // 400ms (increased for layout stability)
static const NSTimeInterval kPositionVerificationDelay = 0.1;   // 100ms position verification
static const NSTimeInterval kWindowMoveDebounceInterval = 0.5;  // 500ms
static const NSTimeInterval kBoundsCacheValidityDuration = 1.0; // 1 second

// Callback function for accessibility events
static void WordAdapterAccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon);

@implementation MicrosoftWordAdapter {
    AXObserverRef _observer;
    AXUIElementRef _wordApp;
    CFRunLoopRef _observerRunLoop;  // RunLoop where observer was registered

    // State tracking
    BOOL _isChanging;           // Whether Word is currently changing (scroll, move, resize)
    BOOL _isScrolling;          // Scroll in progress
    BOOL _isWindowMoving;       // Window move/resize in progress

    // Debounce timers
    NSTimer* _scrollDebounceTimer;
    NSTimer* _windowMoveDebounceTimer;
    NSTimer* _focusChangeDebounceTimer;

    // Position tracking for scroll detection
    CGPoint _lastLayoutCornerPosition;
    BOOL _hasLastLayoutCornerPosition;

    // Momentum scroll tracking
    BOOL _isMomentumScrollActive;       // Whether momentum (inertial) scrolling is in progress
    NSEventPhase _lastScrollPhase;      // Last scroll phase seen
    NSEventPhase _lastMomentumPhase;    // Last momentum phase seen

    // Cached position data for performance
    CGRect _cachedWordBounds;
    NSTimeInterval _lastBoundsUpdate;
    CGRect _cachedScrollAreaBounds;
    NSTimeInterval _lastScrollAreaUpdate;

    // App activation observers
    id _appActivationObserver;
    id _appDeactivationObserver;

    // Scroll event monitor
    id _scrollEventMonitor;
}

#pragma mark - Initialization

- (instancetype)initWithPID:(pid_t)pid delegate:(nullable id<MicrosoftWordAdapterDelegate>)delegate {
    self = [super init];
    if (self) {
        _wordPID = pid;
        _delegate = delegate;
        _wordApp = AXUIElementCreateApplication(pid);
        _observer = NULL;
        _observerRunLoop = NULL;
        _isObserving = NO;

        // Initialize state
        _isChanging = NO;
        _isScrolling = NO;
        _isWindowMoving = NO;
        _lastLayoutCornerPosition = CGPointZero;
        _hasLastLayoutCornerPosition = NO;

        // Initialize momentum tracking
        _isMomentumScrollActive = NO;
        _lastScrollPhase = NSEventPhaseNone;
        _lastMomentumPhase = NSEventPhaseNone;

        // Initialize caches
        _cachedWordBounds = CGRectZero;
        _lastBoundsUpdate = 0;
        _cachedScrollAreaBounds = CGRectZero;
        _lastScrollAreaUpdate = 0;

        // Initialize logging flags
        _enableGetLayoutBoundsLogging = YES;

        NSLog(@"[MicrosoftWordAdapter] Initialized for PID: %d", pid);
    }
    return self;
}

- (void)dealloc {
    NSLog(@"[MicrosoftWordAdapter] Deallocating adapter for PID: %d", _wordPID);
    [self stopObserving];

    if (_wordApp) {
        CFRelease(_wordApp);
        _wordApp = NULL;
    }
}

#pragma mark - Observation Control

- (BOOL)checkAccessibilityPermission {
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

- (BOOL)startObserving:(NSError *_Nullable *_Nullable)error {
    if (_isObserving) {
        NSLog(@"[MicrosoftWordAdapter] Already observing");
        return YES;
    }

    // Check accessibility permission
    if (![self checkAccessibilityPermission]) {
        if (error) {
            *error = [NSError errorWithDomain:@"MicrosoftWordAdapter"
                                        code:1
                                    userInfo:@{NSLocalizedDescriptionKey: @"Accessibility permission not granted"}];
        }
        return NO;
    }

    // Create AX observer
    AXError result = AXObserverCreate(_wordPID, WordAdapterAccessibilityCallback, &_observer);
    if (result != kAXErrorSuccess) {
        if (error) {
            *error = [NSError errorWithDomain:@"MicrosoftWordAdapter"
                                        code:result
                                    userInfo:@{NSLocalizedDescriptionKey: @"Failed to create AX observer"}];
        }
        return NO;
    }

    // Add window position/size notifications for instant updates
    AXObserverAddNotification(_observer, _wordApp, kAXWindowMovedNotification, (__bridge void*)self);
    AXObserverAddNotification(_observer, _wordApp, kAXWindowResizedNotification, (__bridge void*)self);

    // Add focus change notification to track when focused element changes
    AXObserverAddNotification(_observer, _wordApp, kAXFocusedUIElementChangedNotification, (__bridge void*)self);

    // Add observer to run loop and store the runloop for later cleanup
    _observerRunLoop = CFRunLoopGetCurrent();
    CFRetain(_observerRunLoop);  // Retain to ensure it's valid during cleanup
    CFRunLoopAddSource(_observerRunLoop,
                       AXObserverGetRunLoopSource(_observer),
                       kCFRunLoopDefaultMode);

    // Register for app activation/deactivation notifications
    [self registerAppObservers];

    // Setup scroll event monitoring
    __weak typeof(self) weakSelf = self;
    _scrollEventMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                                                  handler:^(NSEvent *event) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        // Get current mouse location in screen coordinates
        NSPoint mouseLocation = [NSEvent mouseLocation];
        CGPoint mouseCGPoint = CGPointMake(mouseLocation.x, mouseLocation.y);

        // Get scroll area bounds (with caching fallback)
        CGRect scrollBounds = [strongSelf getScrollAreaBounds];
        BOOL usedCache = NO;

        // If bounds is empty, try to use cached bounds
        if (CGRectEqualToRect(scrollBounds, CGRectZero)) {
            scrollBounds = strongSelf->_cachedScrollAreaBounds;
            usedCache = YES;
        }

        // If still empty, skip (no-op - we don't know the bounds)
        if (CGRectEqualToRect(scrollBounds, CGRectZero)) {
            NSLog(@"[MicrosoftWordAdapter] Scroll event SKIPPED - scroll area bounds unknown (mouse: %.1f, %.1f)",
                  mouseCGPoint.x, mouseCGPoint.y);
            return;
        }

        // Check if mouse is within scroll area bounds
        if (CGRectContainsPoint(scrollBounds, mouseCGPoint)) {
            NSLog(@"[MicrosoftWordAdapter] Scroll event detected in scroll area (bounds source: %@, mouse: %.1f, %.1f)",
                  usedCache ? @"cached" : @"fresh", mouseCGPoint.x, mouseCGPoint.y);
            [strongSelf handleScrollEvent:event];
        }
    }];

    _isObserving = YES;
    NSLog(@"[MicrosoftWordAdapter] Started observing Word (PID: %d)", _wordPID);

    return YES;
}

- (void)stopObserving {
    if (!_isObserving) {
        return;
    }

    NSLog(@"[MicrosoftWordAdapter] Stopping observation of Word (PID: %d)", _wordPID);

    // Invalidate timers
    [_scrollDebounceTimer invalidate];
    _scrollDebounceTimer = nil;

    [_windowMoveDebounceTimer invalidate];
    _windowMoveDebounceTimer = nil;

    [_focusChangeDebounceTimer invalidate];
    _focusChangeDebounceTimer = nil;

    // Remove scroll event monitor
    if (_scrollEventMonitor) {
        [NSEvent removeMonitor:_scrollEventMonitor];
        _scrollEventMonitor = nil;
    }

    // Unregister app observers
    [self unregisterAppObservers];

    // Remove AX observer
    if (_observer) {
        // Use the stored runloop to ensure proper cleanup even if called from different thread
        if (_observerRunLoop) {
            CFRunLoopRemoveSource(_observerRunLoop,
                                  AXObserverGetRunLoopSource(_observer),
                                  kCFRunLoopDefaultMode);
            CFRelease(_observerRunLoop);
            _observerRunLoop = NULL;
        }
        CFRelease(_observer);
        _observer = NULL;
    }

    _isObserving = NO;
}

#pragma mark - App Lifecycle Observers

- (void)registerAppObservers {
    __weak typeof(self) weakSelf = self;

    // Listen for app activation
    _appActivationObserver = [[NSWorkspace sharedWorkspace].notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];

        if (app.processIdentifier == strongSelf->_wordPID) {
            // Word activated
            NSLog(@"[MicrosoftWordAdapter] Word activated");
            [strongSelf handleWordActivated];
        } else if (app.processIdentifier != [[NSRunningApplication currentApplication] processIdentifier]) {
            // Different app activated (not Word, not our app)
            NSLog(@"[MicrosoftWordAdapter] Different app activated: %@", app.localizedName);
            [strongSelf handleWordDeactivated];
        }
    }];
}

- (void)unregisterAppObservers {
    if (_appActivationObserver) {
        [[NSWorkspace sharedWorkspace].notificationCenter removeObserver:_appActivationObserver];
        _appActivationObserver = nil;
    }
}

#pragma mark - Event Handlers

- (void)handleWordActivated {
    NSLog(@"[MicrosoftWordAdapter] handleWordActivated: Word application activated");

    // Update caches immediately on activation
    [self updateCachedWordBounds];
    [self invalidateScrollAreaCache];

    NSLog(@"[MicrosoftWordAdapter] handleWordActivated: Proactively querying scroll area bounds after activation");

    // Proactively query scroll area to populate cache
    CGRect scrollAreaBounds = [self getScrollAreaBounds];
    if (CGRectEqualToRect(scrollAreaBounds, CGRectZero)) {
        NSLog(@"[MicrosoftWordAdapter] handleWordActivated: WARNING - Scroll area bounds still empty after activation query");
    } else {
        NSLog(@"[MicrosoftWordAdapter] handleWordActivated: Successfully got scroll area bounds on activation: (%.1f, %.1f, %.1f x %.1f)",
              scrollAreaBounds.origin.x, scrollAreaBounds.origin.y,
              scrollAreaBounds.size.width, scrollAreaBounds.size.height);
    }

    // Notify delegate
    if ([_delegate respondsToSelector:@selector(wordAdapterDidActivate:)]) {
        [_delegate wordAdapterDidActivate:self];
    }

    // Complete any pending changes
    [self handleChangeComplete];
}

- (void)handleWordDeactivated {
    // Mark as changing when Word is deactivated
    if (!_isChanging) {
        _isChanging = YES;

        // Notify delegate: change started
        if (_delegate) {
            [_delegate wordAdapterDidStartChanging:self];
        }
    }

    // Notify delegate
    if ([_delegate respondsToSelector:@selector(wordAdapterDidDeactivate:)]) {
        [_delegate wordAdapterDidDeactivate:self];
    }
}

- (void)handleFocusChanged {
    NSLog(@"[MicrosoftWordAdapter] Focus changed detected");

    // Mark as changing if not already
    if (!_isChanging) {
        _isChanging = YES;

        // Notify delegate: change started
        if (_delegate) {
            [_delegate wordAdapterDidStartChanging:self];
        }
    }

    // Cancel existing debounce timer
    [_focusChangeDebounceTimer invalidate];

    // Start new debounce timer (same interval as scroll events)
    __weak typeof(self) weakSelf = self;
    _focusChangeDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:kScrollDebounceInterval
                                                                 repeats:NO
                                                                   block:^(NSTimer * _Nonnull timer) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf) {
            NSLog(@"[MicrosoftWordAdapter] Focus change debounce timer fired");
            [strongSelf handleChangeComplete];
            strongSelf->_focusChangeDebounceTimer = nil;
        }
    }];
}

- (void)handleWindowMoveOrResize {
    NSLog(@"[MicrosoftWordAdapter] Window move/resize detected");

    // Mark as changing if not already
    if (!_isChanging) {
        _isChanging = YES;
        _isWindowMoving = YES;

        // Notify delegate: change started
        if (_delegate) {
            [_delegate wordAdapterDidStartChanging:self];
        }
    }

    // Update cached Word bounds immediately
    [self updateCachedWordBounds];
    [self invalidateScrollAreaCache];

    // Cancel existing debounce timer
    [_windowMoveDebounceTimer invalidate];

    // Start new debounce timer
    __weak typeof(self) weakSelf = self;
    _windowMoveDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:kWindowMoveDebounceInterval
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf) {
            [strongSelf handleChangeComplete];
            strongSelf->_windowMoveDebounceTimer = nil;
            strongSelf->_isWindowMoving = NO;
        }
    }];
}

- (void)handleScrollEvent:(NSEvent *)event {
    // Extract phase information from the scroll event
    NSEventPhase phase = event.phase;
    NSEventPhase momentumPhase = event.momentumPhase;

    // Track momentum state changes
    BOOL wasMomentumActive = _isMomentumScrollActive;

    // Update momentum tracking based on phases
    if (momentumPhase == NSEventPhaseBegan) {
        _isMomentumScrollActive = YES;
        NSLog(@"[MicrosoftWordAdapter] Momentum scroll BEGAN");
    } else if (momentumPhase == NSEventPhaseEnded || momentumPhase == NSEventPhaseCancelled) {
        _isMomentumScrollActive = NO;
        NSLog(@"[MicrosoftWordAdapter] Momentum scroll ENDED");
    }

    // Store phase information for debugging
    _lastScrollPhase = phase;
    _lastMomentumPhase = momentumPhase;

    NSLog(@"[MicrosoftWordAdapter] Scroll event - phase: %ld, momentumPhase: %ld, isMomentumActive: %@",
          (long)phase, (long)momentumPhase, _isMomentumScrollActive ? @"YES" : @"NO");

    // === PHASE 1: DETECT SCROLL START (using event phases, not position) ===

    // Check if this is the beginning of a scroll gesture
    BOOL scrollStarting = NO;

    if (phase == NSEventPhaseBegan) {
        // Trackpad scroll started
        scrollStarting = YES;
        NSLog(@"[MicrosoftWordAdapter] Scroll gesture BEGAN (phase == Began)");
    } else if (momentumPhase == NSEventPhaseBegan) {
        // Momentum phase started (shouldn't trigger new "change start" but log it)
        NSLog(@"[MicrosoftWordAdapter] Momentum phase BEGAN (not triggering change start)");
    } else if (!_isScrolling && (phase == NSEventPhaseChanged || phase != NSEventPhaseNone)) {
        // First scroll event without explicit "Began" phase (some mice/trackpads)
        scrollStarting = YES;
        NSLog(@"[MicrosoftWordAdapter] Scroll detected without Began phase (phase: %ld)", (long)phase);
    }

    // Trigger "change start" notification based on scroll gesture beginning
    if (scrollStarting && !_isChanging) {
        _isChanging = YES;
        _isScrolling = YES;

        NSLog(@"[MicrosoftWordAdapter] *** CHANGE START triggered ***");

        // Notify delegate: change started
        if (_delegate) {
            [_delegate wordAdapterDidStartChanging:self];
        }
    }

    // === PHASE 2: HANDLE POSITION CHANGES (for debouncing logic) ===

    CGPoint currentLayoutCornerPosition = [self getLayoutBounds].origin;

    // Check if position changed immediately (may not due to Word's async layout)
    BOOL positionChangedImmediately = _hasLastLayoutCornerPosition &&
                                      !CGPointEqualToPoint(currentLayoutCornerPosition, _lastLayoutCornerPosition);

    if (positionChangedImmediately) {
        // Position changed right away (fast scroll or Word updated quickly)
        NSLog(@"[MicrosoftWordAdapter] Position changed immediately: (%.1f, %.1f) -> (%.1f, %.1f)",
              _lastLayoutCornerPosition.x, _lastLayoutCornerPosition.y,
              currentLayoutCornerPosition.x, currentLayoutCornerPosition.y);

        _lastLayoutCornerPosition = currentLayoutCornerPosition;
        _hasLastLayoutCornerPosition = YES;

    } else if (!_hasLastLayoutCornerPosition && !CGPointEqualToPoint(currentLayoutCornerPosition, CGPointZero)) {
        // First scroll event - establish position baseline
        _lastLayoutCornerPosition = currentLayoutCornerPosition;
        _hasLastLayoutCornerPosition = YES;
        NSLog(@"[MicrosoftWordAdapter] Established initial position baseline: (%.1f, %.1f)",
              currentLayoutCornerPosition.x, currentLayoutCornerPosition.y);

    } else {
        // Position hasn't changed YET (Word's layout updating asynchronously)
        // Trust the scroll event and start debounce timer anyway
        // verifyPositionStableAndComplete will catch the position change later
        NSLog(@"[MicrosoftWordAdapter] Position unchanged yet (Word layout lag), trusting scroll event");

        // Special case: momentum just ended
        if (!_isMomentumScrollActive && wasMomentumActive) {
            NSLog(@"[MicrosoftWordAdapter] Momentum ended, triggering immediate verification");
            [self verifyPositionStableAndComplete];
            return;
        }

        // Don't return early - fall through to timer logic below
    }

    // Always manage debounce timer when scroll events occur
    [_scrollDebounceTimer invalidate];

    // Only start debounce timer if not in momentum phase
    // During momentum scrolling, we wait for momentum to end
    if (!_isMomentumScrollActive) {
        NSLog(@"[MicrosoftWordAdapter] Starting/resetting debounce timer (400ms + 100ms verification)");
        __weak typeof(self) weakSelf = self;
        _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:kScrollDebounceInterval
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
            typeof(self) strongSelf = weakSelf;
            if (strongSelf) {
                NSLog(@"[MicrosoftWordAdapter] Debounce timer fired, verifying position stability");
                [strongSelf verifyPositionStableAndComplete];
                strongSelf->_scrollDebounceTimer = nil;
            }
        }];
    } else {
        NSLog(@"[MicrosoftWordAdapter] Momentum active - deferring debounce timer until momentum ends");
    }
}

- (void)verifyPositionStableAndComplete {
    NSLog(@"[MicrosoftWordAdapter] Verifying position stability before completing change");

    // Take initial position sample
    CGPoint initialPosition = [self getLayoutBounds].origin;

    if (CGPointEqualToPoint(initialPosition, CGPointZero)) {
        NSLog(@"[MicrosoftWordAdapter] Position verification SKIPPED - initial position is zero");
        // Position invalid, just complete anyway
        [self handleChangeComplete];
        return;
    }

    NSLog(@"[MicrosoftWordAdapter] Initial position sample: (%.1f, %.1f)", initialPosition.x, initialPosition.y);

    // Wait a short period and re-sample
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kPositionVerificationDelay * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        CGPoint verifyPosition = [strongSelf getLayoutBounds].origin;
        NSLog(@"[MicrosoftWordAdapter] Verification position sample: (%.1f, %.1f)", verifyPosition.x, verifyPosition.y);

        // Check if position is stable (hasn't changed)
        if (CGPointEqualToPoint(initialPosition, verifyPosition)) {
            NSLog(@"[MicrosoftWordAdapter] Position STABLE - completing change");
            [strongSelf handleChangeComplete];
            strongSelf->_isScrolling = NO;
        } else {
            NSLog(@"[MicrosoftWordAdapter] Position STILL CHANGING - layout not stable yet, restarting debounce");
            // Position still changing, restart the debounce cycle
            // This simulates receiving another scroll event
            strongSelf->_lastLayoutCornerPosition = verifyPosition;
            strongSelf->_hasLastLayoutCornerPosition = YES;

            // Restart debounce timer
            [strongSelf->_scrollDebounceTimer invalidate];
            __weak typeof(strongSelf) weakSelf2 = strongSelf;
            strongSelf->_scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:kScrollDebounceInterval
                                                                                repeats:NO
                                                                                  block:^(NSTimer * _Nonnull timer) {
                typeof(strongSelf) strongSelf2 = weakSelf2;
                if (strongSelf2) {
                    NSLog(@"[MicrosoftWordAdapter] Retry debounce timer fired, verifying again");
                    [strongSelf2 verifyPositionStableAndComplete];
                    strongSelf2->_scrollDebounceTimer = nil;
                }
            }];
        }
    });
}

- (void)handleChangeComplete {
    NSLog(@"[MicrosoftWordAdapter] Change complete (debounced)");

    _isChanging = NO;

    // Get current state snapshot
    WordPositionState state = [self getCurrentState];

    // Notify delegate: change complete
    if (_delegate) {
        [_delegate wordAdapterDidCompleteChanging:self withState:state];
    }
}

#pragma mark - Position Query Methods

- (CGRect)getWordWindowBounds {
    // Return cached bounds if still valid
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    if (!CGRectEqualToRect(_cachedWordBounds, CGRectZero) &&
        (now - _lastBoundsUpdate) < kBoundsCacheValidityDuration) {
        return _cachedWordBounds;
    }

    // Query fresh bounds
    return [self queryWordWindowBounds];
}

- (CGRect)queryWordWindowBounds {
    // Get the frontmost window of Word
    CFTypeRef windowsRef = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXWindowsAttribute, &windowsRef);

    if (error != kAXErrorSuccess || !windowsRef) {
        return CGRectZero;
    }

    CFArrayRef windows = (CFArrayRef)windowsRef;
    if (CFArrayGetCount(windows) == 0) {
        CFRelease(windowsRef);
        return CGRectZero;
    }

    // Get the first window (frontmost)
    AXUIElementRef frontWindow = (AXUIElementRef)CFArrayGetValueAtIndex(windows, 0);

    // Get window position
    CFTypeRef positionValue = NULL;
    error = AXUIElementCopyAttributeValue(frontWindow, kAXPositionAttribute, &positionValue);
    CGPoint position = CGPointZero;
    if (error == kAXErrorSuccess && positionValue) {
        AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position);
        CFRelease(positionValue);
    }

    // Get window size
    CFTypeRef sizeValue = NULL;
    error = AXUIElementCopyAttributeValue(frontWindow, kAXSizeAttribute, &sizeValue);
    CGSize size = CGSizeZero;
    if (error == kAXErrorSuccess && sizeValue) {
        AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size);
        CFRelease(sizeValue);
    }

    CFRelease(windowsRef);

    return CGRectMake(position.x, position.y, size.width, size.height);
}

- (CGRect)getScrollAreaBounds {
    // Return cached bounds if still valid (only invalidated explicitly, not by duration)
    if (!CGRectEqualToRect(_cachedScrollAreaBounds, CGRectZero)) {
        return _cachedScrollAreaBounds;
    }

    NSLog(@"[MicrosoftWordAdapter] getScrollAreaBounds: CACHE MISS (cached empty) - querying fresh bounds");

    // Query fresh scroll area bounds
    CGRect scrollBounds = [self queryScrollAreaBounds];

    // Update cache
    if (!CGRectEqualToRect(scrollBounds, CGRectZero)) {
        _cachedScrollAreaBounds = scrollBounds;
        _lastScrollAreaUpdate = [[NSDate date] timeIntervalSince1970];
        NSLog(@"[MicrosoftWordAdapter] getScrollAreaBounds: Updated cache with fresh bounds");
    } else {
        NSLog(@"[MicrosoftWordAdapter] getScrollAreaBounds: Query returned empty bounds, cache not updated");
    }

    return scrollBounds;
}

- (CGRect)queryScrollAreaBounds {
    NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: Starting scroll area query");

    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: FAILED - No focused element (error: %d)", error);
        return CGRectZero;
    }

    NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: Successfully got focused element");

    // Walk up parent hierarchy to find AXScrollArea at level 4
    NSMutableArray* hierarchy = [NSMutableArray array];
    AXUIElementRef currentElement = focusedElement;
    CFRetain(currentElement);

    NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: Walking accessibility hierarchy...");

    for (int i = 0; i < 20; i++) {
        // Get role
        CFTypeRef roleValue = NULL;
        AXUIElementCopyAttributeValue(currentElement, kAXRoleAttribute, &roleValue);
        NSString* role = (__bridge_transfer NSString*)roleValue;

        // Get position
        CFTypeRef positionValue = NULL;
        error = AXUIElementCopyAttributeValue(currentElement, kAXPositionAttribute, &positionValue);
        CGPoint position = CGPointZero;
        if (error == kAXErrorSuccess && positionValue) {
            AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position);
            CFRelease(positionValue);
        }

        // Get size
        CFTypeRef sizeValue = NULL;
        AXUIElementCopyAttributeValue(currentElement, kAXSizeAttribute, &sizeValue);
        CGSize size = CGSizeZero;
        if (sizeValue) {
            AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size);
            CFRelease(sizeValue);
        }

        // Log this level
        NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds:   Level %d: %@ (pos: %.1f, %.1f, size: %.1f x %.1f)",
              i, role ?: @"Unknown", position.x, position.y, size.width, size.height);

        // Store this level
        [hierarchy addObject:@{
            @"level": @(i),
            @"role": role ?: @"Unknown",
            @"position": [NSValue valueWithPoint:NSPointFromCGPoint(position)],
            @"size": [NSValue valueWithSize:NSSizeFromCGSize(size)]
        }];

        // Get parent element
        CFTypeRef parentValue = NULL;
        error = AXUIElementCopyAttributeValue(currentElement, kAXParentAttribute, &parentValue);

        if (error != kAXErrorSuccess || !parentValue) {
            break;
        }

        if (currentElement != focusedElement) {
            CFRelease(currentElement);
        }

        currentElement = (AXUIElementRef)parentValue;
    }

    // Clean up
    if (currentElement != focusedElement) {
        CFRelease(currentElement);
    }
    CFRelease(focusedElement);

    // Find AXScrollArea in hierarchy at any level
    int scrollAreaLevel = -1;
    for (NSDictionary* item in hierarchy) {
        if ([item[@"role"] isEqualToString:(__bridge NSString*)kAXScrollAreaRole]) {
            scrollAreaLevel = [item[@"level"] intValue];

            // Get the bounds of the scroll area
            CGPoint position = NSPointToCGPoint([item[@"position"] pointValue]);
            CGSize size = NSSizeToCGSize([item[@"size"] sizeValue]);

            // Verify that the scroll area has valid (non-zero) dimensions
            if (size.width > 0 && size.height > 0) {
                CGRect result = CGRectMake(position.x, position.y, size.width, size.height);
                NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: SUCCESS - Found AXScrollArea at level %d: (%.1f, %.1f, %.1f x %.1f)",
                      scrollAreaLevel, result.origin.x, result.origin.y, result.size.width, result.size.height);
                return result;
            } else {
                NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: Found AXScrollArea at level %d but it has invalid dimensions (%.1f x %.1f)",
                      scrollAreaLevel, size.width, size.height);
            }
        }
    }

    NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: No AXScrollArea found, attempting fallback strategy");

    // Fallback: Find AXWindow in hierarchy and use the element directly below it
    // This handles cases where there's no explicit AXScrollArea but the content area
    // is represented by a split group or group element
    int windowLevel = -1;
    for (NSDictionary* item in hierarchy) {
        if ([item[@"role"] isEqualToString:(__bridge NSString*)kAXWindowRole]) {
            windowLevel = [item[@"level"] intValue];
            NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: Found AXWindow at level %d", windowLevel);
            break;
        }
    }

    if (windowLevel > 0) {
        // Get the element one level below the window (windowLevel - 1)
        int targetLevel = windowLevel - 1;
        for (NSDictionary* item in hierarchy) {
            if ([item[@"level"] intValue] == targetLevel) {
                NSString* role = item[@"role"];
                CGPoint position = NSPointToCGPoint([item[@"position"] pointValue]);
                CGSize size = NSSizeToCGSize([item[@"size"] sizeValue]);

                if (size.width > 0 && size.height > 0) {
                    CGRect result = CGRectMake(position.x, position.y, size.width, size.height);
                    NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: SUCCESS (fallback) - Using %@ at level %d: (%.1f, %.1f, %.1f x %.1f)",
                          role, targetLevel, result.origin.x, result.origin.y, result.size.width, result.size.height);
                    return result;
                } else {
                    NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: Element at level %d has invalid dimensions (%.1f x %.1f)",
                          targetLevel, size.width, size.height);
                }
                break;
            }
        }
    }

    NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: FAILED - No valid scroll area or fallback element found");
    return CGRectZero;
}

- (CGRect)getLayoutBounds {
    if (self.enableGetLayoutBoundsLogging) {
        NSLog(@"[getLayoutBounds] === FUNCTION CALLED ===");
    }

    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (self.enableGetLayoutBoundsLogging) {
        NSLog(@"[getLayoutBounds] Getting focused element: error=%d, element=%p", error, focusedElement);
    }

    if (error != kAXErrorSuccess || !focusedElement) {
        if (self.enableGetLayoutBoundsLogging) {
            NSLog(@"[getLayoutBounds] ERROR: Failed to get focused element (error=%d). Returning CGRectZero", error);
        }
        return CGRectZero;
    }

    // Strategy: Find AXTextArea in hierarchy, then get position AND size 2 levels up from it
    AXUIElementRef currentElement = focusedElement;
    CFRetain(currentElement);
    AXUIElementRef layoutElement = NULL;
    int textAreaLevel = -1;

    if (self.enableGetLayoutBoundsLogging) {
        NSLog(@"[getLayoutBounds] Starting hierarchy walk (max 20 levels)");
    }

    // Walk up the hierarchy looking for AXTextArea
    for (int i = 0; i < 20; i++) {
        // Get role
        CFTypeRef roleValue = NULL;
        AXUIElementCopyAttributeValue(currentElement, kAXRoleAttribute, &roleValue);
        NSString* role = (__bridge_transfer NSString*)roleValue;

        if (self.enableGetLayoutBoundsLogging) {
            NSLog(@"[getLayoutBounds] Level %d: role='%@', element=%p", i, role ? role : @"(null)", currentElement);
        }

        // Check if this is the text area
        if ([role isEqualToString:(__bridge NSString*)kAXTextAreaRole]) {
            textAreaLevel = i;
            if (self.enableGetLayoutBoundsLogging) {
                NSLog(@"[getLayoutBounds] *** FOUND AXTextArea at level %d! Walking up 3 more levels...", i);
            }

            // Need to go up 3 more levels to get the layout element
            // Continue walking to get 3 levels up
            for (int j = 0; j < 3; j++) {
                CFTypeRef parentValue = NULL;
                error = AXUIElementCopyAttributeValue(currentElement, kAXParentAttribute, &parentValue);

                if (self.enableGetLayoutBoundsLogging) {
                    // Get role of parent element
                    NSString* parentRole = @"(unknown)";
                    if (error == kAXErrorSuccess && parentValue) {
                        CFTypeRef parentRoleValue = NULL;
                        AXUIElementCopyAttributeValue((AXUIElementRef)parentValue, kAXRoleAttribute, &parentRoleValue);
                        if (parentRoleValue) {
                            parentRole = (__bridge_transfer NSString*)parentRoleValue;
                        }
                    }
                    NSLog(@"[getLayoutBounds]   Going up level %d/3: error=%d, parent=%p, role='%@'", j+1, error, parentValue, parentRole);
                }

                if (error != kAXErrorSuccess || !parentValue) {
                    if (self.enableGetLayoutBoundsLogging) {
                        NSLog(@"[getLayoutBounds]   ERROR: Failed to get parent at level %d/3 (error=%d)", j+1, error);
                    }
                    break;
                }
                if (currentElement != focusedElement) {
                    CFRelease(currentElement);
                }
                currentElement = (AXUIElementRef)parentValue;
            }
            layoutElement = currentElement;
            CFRetain(layoutElement);  // Retain so we can use it after cleanup

            if (self.enableGetLayoutBoundsLogging) {
                // Get role of layout element
                NSString* layoutRole = @"(unknown)";
                CFTypeRef layoutRoleValue = NULL;
                AXUIElementCopyAttributeValue(layoutElement, kAXRoleAttribute, &layoutRoleValue);
                if (layoutRoleValue) {
                    layoutRole = (__bridge_transfer NSString*)layoutRoleValue;
                }
                NSLog(@"[getLayoutBounds] Layout element set: %p, role='%@'", layoutElement, layoutRole);

                // Get and log all children of the layout element
                CFTypeRef childrenValue = NULL;
                AXError childrenError = AXUIElementCopyAttributeValue(layoutElement, kAXChildrenAttribute, &childrenValue);
                if (childrenError == kAXErrorSuccess && childrenValue) {
                    NSArray* children = (__bridge_transfer NSArray*)childrenValue;
                    NSLog(@"[getLayoutBounds] Layout element has %lu children", (unsigned long)[children count]);

                    // Build array of child info (role, position, size)
                    NSMutableArray* childInfoArray = [NSMutableArray array];
                    for (id childObj in children) {
                        AXUIElementRef child = (__bridge AXUIElementRef)childObj;

                        // Get role
                        NSString* childRole = @"(unknown)";
                        CFTypeRef childRoleValue = NULL;
                        if (AXUIElementCopyAttributeValue(child, kAXRoleAttribute, &childRoleValue) == kAXErrorSuccess && childRoleValue) {
                            childRole = (__bridge_transfer NSString*)childRoleValue;
                        }

                        // Get position
                        CGPoint childPos = CGPointZero;
                        CFTypeRef childPosValue = NULL;
                        if (AXUIElementCopyAttributeValue(child, kAXPositionAttribute, &childPosValue) == kAXErrorSuccess && childPosValue) {
                            AXValueGetValue((AXValueRef)childPosValue, kAXValueTypeCGPoint, &childPos);
                            CFRelease(childPosValue);
                        }

                        // Get size
                        CGSize childSize = CGSizeZero;
                        CFTypeRef childSizeValue = NULL;
                        if (AXUIElementCopyAttributeValue(child, kAXSizeAttribute, &childSizeValue) == kAXErrorSuccess && childSizeValue) {
                            AXValueGetValue((AXValueRef)childSizeValue, kAXValueTypeCGSize, &childSize);
                            CFRelease(childSizeValue);
                        }

                        [childInfoArray addObject:@{
                            @"role": childRole,
                            @"y": @(childPos.y),
                            @"x": @(childPos.x),
                            @"width": @(childSize.width),
                            @"height": @(childSize.height),
                            @"element": [NSValue valueWithPointer:child]
                        }];
                    }

                    // Sort by Y position (increasing)
                    NSArray* sortedChildren = [childInfoArray sortedArrayUsingComparator:^NSComparisonResult(NSDictionary* obj1, NSDictionary* obj2) {
                        CGFloat y1 = [obj1[@"y"] doubleValue];
                        CGFloat y2 = [obj2[@"y"] doubleValue];
                        if (y1 < y2) return NSOrderedAscending;
                        if (y1 > y2) return NSOrderedDescending;
                        return NSOrderedSame;
                    }];

                    // Log all children sorted by Y
                    NSLog(@"[getLayoutBounds] === Children sorted by Y position (increasing) ===");
                    for (NSDictionary* childInfo in sortedChildren) {
                        void* childPtr = [childInfo[@"element"] pointerValue];
                        NSLog(@"[getLayoutBounds]   Child %p: role='%@', pos=(%.1f, %.1f), size=(%.1f x %.1f)",
                              childPtr,
                              childInfo[@"role"],
                              [childInfo[@"x"] doubleValue],
                              [childInfo[@"y"] doubleValue],
                              [childInfo[@"width"] doubleValue],
                              [childInfo[@"height"] doubleValue]);
                    }
                    NSLog(@"[getLayoutBounds] === End of children list ===");
                } else {
                    NSLog(@"[getLayoutBounds] Failed to get children (error=%d)", childrenError);
                }
            }
            break;
        }

        // Get parent element
        CFTypeRef parentValue = NULL;
        error = AXUIElementCopyAttributeValue(currentElement, kAXParentAttribute, &parentValue);

        if (self.enableGetLayoutBoundsLogging) {
            NSLog(@"[getLayoutBounds] Getting parent from level %d: error=%d, parent=%p", i, error, parentValue);
        }

        if (error != kAXErrorSuccess || !parentValue) {
            if (self.enableGetLayoutBoundsLogging) {
                NSLog(@"[getLayoutBounds] ERROR: Failed to get parent at level %d (error=%d). Breaking hierarchy walk.", i, error);
            }
            break;
        }

        if (currentElement != focusedElement) {
            CFRelease(currentElement);
        }

        currentElement = (AXUIElementRef)parentValue;
    }

    // Clean up current element
    if (currentElement != focusedElement) {
        CFRelease(currentElement);
    }
    CFRelease(focusedElement);

    if (self.enableGetLayoutBoundsLogging) {
        NSLog(@"[getLayoutBounds] Hierarchy walk complete. Layout element: %p (textAreaLevel=%d)", layoutElement, textAreaLevel);
    }

    // If we found the layout element, find the child with smallest Y value
    if (layoutElement) {
        // Get all children
        CFTypeRef childrenValue = NULL;
        error = AXUIElementCopyAttributeValue(layoutElement, kAXChildrenAttribute, &childrenValue);

        if (error == kAXErrorSuccess && childrenValue) {
            NSArray* children = (__bridge_transfer NSArray*)childrenValue;

            if (self.enableGetLayoutBoundsLogging) {
                NSLog(@"[getLayoutBounds] Finding child with smallest Y value from %lu children", (unsigned long)[children count]);
            }

            // Find child with smallest Y value
            AXUIElementRef topChild = NULL;
            CGFloat minY = CGFLOAT_MAX;
            CGPoint topChildPos = CGPointZero;
            CGSize topChildSize = CGSizeZero;

            for (id childObj in children) {
                AXUIElementRef child = (__bridge AXUIElementRef)childObj;

                // Get position
                CGPoint childPos = CGPointZero;
                CFTypeRef childPosValue = NULL;
                if (AXUIElementCopyAttributeValue(child, kAXPositionAttribute, &childPosValue) == kAXErrorSuccess && childPosValue) {
                    AXValueGetValue((AXValueRef)childPosValue, kAXValueTypeCGPoint, &childPos);
                    CFRelease(childPosValue);

                    if (childPos.y < minY) {
                        minY = childPos.y;
                        topChild = child;
                        topChildPos = childPos;

                        // Get size
                        CFTypeRef childSizeValue = NULL;
                        if (AXUIElementCopyAttributeValue(child, kAXSizeAttribute, &childSizeValue) == kAXErrorSuccess && childSizeValue) {
                            AXValueGetValue((AXValueRef)childSizeValue, kAXValueTypeCGSize, &topChildSize);
                            CFRelease(childSizeValue);
                        }
                    }
                }
            }

            CFRelease(layoutElement);

            if (topChild) {
                CGRect result = CGRectMake(topChildPos.x, topChildPos.y, topChildSize.width, topChildSize.height);
                if (self.enableGetLayoutBoundsLogging) {
                    // Get role of top child
                    NSString* topChildRole = @"(unknown)";
                    CFTypeRef topChildRoleValue = NULL;
                    if (AXUIElementCopyAttributeValue(topChild, kAXRoleAttribute, &topChildRoleValue) == kAXErrorSuccess && topChildRoleValue) {
                        topChildRole = (__bridge_transfer NSString*)topChildRoleValue;
                    }
                    NSLog(@"[getLayoutBounds] Top child (smallest Y): %p, role='%@', y=%.2f", topChild, topChildRole, minY);
                    NSLog(@"[getLayoutBounds] === RETURNING: CGRect(x=%.2f, y=%.2f, width=%.2f, height=%.2f) ===",
                          result.origin.x, result.origin.y, result.size.width, result.size.height);
                }
                return result;
            } else {
                if (self.enableGetLayoutBoundsLogging) {
                    NSLog(@"[getLayoutBounds] ERROR: No valid child found with position");
                }
            }
        } else {
            if (self.enableGetLayoutBoundsLogging) {
                NSLog(@"[getLayoutBounds] ERROR: Failed to get children (error=%d)", error);
            }
            CFRelease(layoutElement);
        }
    }

    if (self.enableGetLayoutBoundsLogging) {
        NSLog(@"[getLayoutBounds] === RETURNING: CGRectZero (no layout element found) ===");
    }
    return CGRectZero;
}

- (CGFloat)getLayoutLeftMargin {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return 0;
    }

    // Get the position of the text area element
    CFTypeRef positionValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXPositionAttribute, &positionValue);

    CGPoint position = CGPointZero;
    if (error == kAXErrorSuccess && positionValue) {
        AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position);
        CFRelease(positionValue);
    }

    CFRelease(focusedElement);

    return position.x;
}

- (CGRect)getFirstLinePosition {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return CGRectZero;
    }

    // Create a range for the first character (location: 0, length: 1)
    CFRange range = CFRangeMake(0, 1);
    AXValueRef rangeValue = AXValueCreate(kAXValueTypeCFRange, &range);

    if (!rangeValue) {
        CFRelease(focusedElement);
        return CGRectZero;
    }

    // Get bounds for the first character
    CFTypeRef boundsValue = NULL;
    error = AXUIElementCopyParameterizedAttributeValue(focusedElement,
                                                       kAXBoundsForRangeParameterizedAttribute,
                                                       rangeValue,
                                                       &boundsValue);

    CGRect bounds = CGRectZero;
    if (error == kAXErrorSuccess && boundsValue) {
        AXValueGetValue((AXValueRef)boundsValue, (AXValueType)kAXValueTypeCGRect, &bounds);
        CFRelease(boundsValue);
    }

    CFRelease(rangeValue);
    CFRelease(focusedElement);

    return bounds;
}

- (CFRange)getVisibleCharacterRange {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return CFRangeMake(0, 0);
    }

    // Get visible character range
    CFTypeRef visibleRangeValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXVisibleCharacterRangeAttribute, &visibleRangeValue);

    CFRange visibleRange = CFRangeMake(0, 0);
    if (error == kAXErrorSuccess && visibleRangeValue) {
        AXValueGetValue((AXValueRef)visibleRangeValue, kAXValueTypeCFRange, &visibleRange);
        CFRelease(visibleRangeValue);
    }

    CFRelease(focusedElement);

    return visibleRange;
}

- (BOOL)isPageCornerVisible {
    // Check if character 0 is in the visible range (viewport check)
    CFRange visibleRange = [self getVisibleCharacterRange];
    BOOL inViewport = (visibleRange.location == 0 && visibleRange.length > 0);

    // Check if the layout corner position is on-screen
    BOOL onScreen = NO;
    if (inViewport) {
        CGPoint cornerPosition = [self getLayoutBounds].origin;
        if (!CGPointEqualToPoint(cornerPosition, CGPointZero)) {
            // Check if position is within any visible screen bounds
            for (NSScreen* screen in [NSScreen screens]) {
                NSRect screenFrame = screen.frame;
                if (cornerPosition.x >= screenFrame.origin.x &&
                    cornerPosition.x <= screenFrame.origin.x + screenFrame.size.width &&
                    cornerPosition.y >= screenFrame.origin.y &&
                    cornerPosition.y <= screenFrame.origin.y + screenFrame.size.height) {
                    onScreen = YES;
                    break;
                }
            }
        }
    }

    return inViewport && onScreen;
}

- (WordPositionState)getCurrentState {
    WordPositionState state;
    state.windowBounds = [self getWordWindowBounds];
    state.scrollAreaBounds = [self getScrollAreaBounds];

    CGRect layoutBounds = [self getLayoutBounds];
    state.layoutPosition = layoutBounds.origin;
    state.layoutSize = layoutBounds.size;

    state.layoutLeftMargin = [self getLayoutLeftMargin];
    state.firstLinePosition = [self getFirstLinePosition];
    state.visibleCharacterRange = [self getVisibleCharacterRange];
    state.isPageCornerVisible = [self isPageCornerVisible];
    return state;
}

#pragma mark - Cache Management

- (void)invalidateCaches {
    NSLog(@"[MicrosoftWordAdapter] Invalidating all caches");
    _cachedWordBounds = CGRectZero;
    _lastBoundsUpdate = 0;
    _cachedScrollAreaBounds = CGRectZero;
    _lastScrollAreaUpdate = 0;
    _hasLastLayoutCornerPosition = NO;
}

- (void)invalidateScrollAreaCache {
    _cachedScrollAreaBounds = CGRectZero;
    _lastScrollAreaUpdate = 0;
}

- (void)updateCachedWordBounds {
    CGRect bounds = [self queryWordWindowBounds];
    if (!CGRectEqualToRect(bounds, CGRectZero)) {
        _cachedWordBounds = bounds;
        _lastBoundsUpdate = [[NSDate date] timeIntervalSince1970];
        NSLog(@"[MicrosoftWordAdapter] Cached Word bounds updated: (%.1f, %.1f, %.1f, %.1f)",
              bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);
    }
}

@end

#pragma mark - Accessibility Callback

static void WordAdapterAccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon) {
    MicrosoftWordAdapter* adapter = (__bridge MicrosoftWordAdapter*)refcon;
    NSString* notificationName = (__bridge NSString*)notification;

    NSLog(@"[MicrosoftWordAdapter] AX Notification: %@", notificationName);

    if ([notificationName isEqualToString:(__bridge NSString*)kAXWindowMovedNotification] ||
        [notificationName isEqualToString:(__bridge NSString*)kAXWindowResizedNotification]) {
        // Window moved or resized
        dispatch_async(dispatch_get_main_queue(), ^{
            [adapter handleWindowMoveOrResize];
        });
    } else if ([notificationName isEqualToString:(__bridge NSString*)kAXFocusedUIElementChangedNotification]) {
        // Focused element changed
        dispatch_async(dispatch_get_main_queue(), ^{
            [adapter handleFocusChanged];
        });
    }
}
