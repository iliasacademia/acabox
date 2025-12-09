//
//  MicrosoftWordAdapter.mm
//  AcademiaElectron
//
//  Implementation of Microsoft Word position tracking adapter
//

#import "MicrosoftWordAdapter.h"
#import "../../bridge.h"  // For AcademiaLog

// Feature flag from bridge.mm (for scroll tracking control)
extern BOOL featureScrollTrackingEnabled;

// Configuration constants
static const NSTimeInterval kScrollDebounceInterval = 0.4;      // 400ms (increased for layout stability)
static const NSTimeInterval kWindowMoveDebounceInterval = 0.5;  // 500ms
static const NSTimeInterval kBoundsCacheValidityDuration = 1.0; // 1 second

// Polling configuration constants (for two-phase position stability detection)
static const NSTimeInterval kPollingInterval = 0.1;             // 100ms polling interval
static const NSTimeInterval kMaxPollingDuration = 5.0;          // 5 second max polling duration
static const NSInteger kStabilitySampleCount = 5;               // Number of samples for stability (500ms / 100ms)

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
    BOOL _wordHasAppFocus;      // Whether Word application has system focus

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

    // Two-phase polling state
    NSMutableArray* _textAreaBoundsHistory;  // Rolling buffer of last N TextArea bounds samples
    NSInteger _pollingAttempts;              // Counter for safety timeout
    NSTimer* _positionPollingTimer;          // 100ms repeating timer for polling
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
        _wordHasAppFocus = NO;
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

        // Initialize polling state
        _textAreaBoundsHistory = [NSMutableArray array];
        _pollingAttempts = 0;
        _positionPollingTimer = nil;
    }
    return self;
}

- (void)dealloc {
    [self stopObserving];

    if (_wordApp) {
        CFRelease(_wordApp);
        _wordApp = NULL;
    }
}

#pragma mark - Observation Control

- (BOOL)checkAccessibilityPermission {
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @NO};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

- (BOOL)startObserving:(NSError *_Nullable *_Nullable)error {
    if (_isObserving) {
        return YES;
    }

    // Check accessibility permission
    if (![self checkAccessibilityPermission]) {
        AcademiaLog(@"[WORD-INTEGRATION] MicrosoftWordAdapter startObserving failed: Accessibility permission not granted for PID %d", _wordPID);
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

    // Setup scroll event monitoring (conditionally based on feature flag)
    if (featureScrollTrackingEnabled) {
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

            // If bounds is empty, try to use cached bounds
            if (CGRectEqualToRect(scrollBounds, CGRectZero)) {
                scrollBounds = strongSelf->_cachedScrollAreaBounds;
            }

            // If still empty, skip (no-op - we don't know the bounds)
            if (CGRectEqualToRect(scrollBounds, CGRectZero)) {
                return;
            }

            // Check if mouse is within scroll area bounds
            if (CGRectContainsPoint(scrollBounds, mouseCGPoint)) {
                [strongSelf handleScrollEvent:event];
            }
        }];
        NSLog(@"[MicrosoftWordAdapter] Scroll event monitor ENABLED");
    } else {
        NSLog(@"[MicrosoftWordAdapter] Scroll event monitor DISABLED by feature flag");
        _scrollEventMonitor = nil;
    }

    _isObserving = YES;

    return YES;
}

- (void)stopObserving {
    if (!_isObserving) {
        return;
    }

    // Invalidate timers
    [_scrollDebounceTimer invalidate];
    _scrollDebounceTimer = nil;

    [_windowMoveDebounceTimer invalidate];
    _windowMoveDebounceTimer = nil;

    [_focusChangeDebounceTimer invalidate];
    _focusChangeDebounceTimer = nil;

    [_positionPollingTimer invalidate];
    _positionPollingTimer = nil;

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
            [strongSelf handleWordActivated];
        } else if (app.processIdentifier != [[NSRunningApplication currentApplication] processIdentifier]) {
            // Different app activated (not Word, not our app)
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
    // Track that Word now has application focus
    _wordHasAppFocus = YES;

    // Update caches immediately on activation
    [self updateCachedWordBounds];
    [self invalidateScrollAreaCache];

    // Proactively query scroll area to populate cache
    CGRect scrollAreaBounds = [self getScrollAreaBounds];
    if (CGRectEqualToRect(scrollAreaBounds, CGRectZero)) {
        NSLog(@"[MicrosoftWordAdapter] WARNING: Scroll area bounds still empty after activation query");
    }

    // Notify delegate
    if ([_delegate respondsToSelector:@selector(wordAdapterDidActivate:)]) {
        [_delegate wordAdapterDidActivate:self];
    }

    // Complete any pending changes
    [self handleChangeComplete];
}

- (void)handleWordDeactivated {
    // Track that Word no longer has application focus
    _wordHasAppFocus = NO;

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
    // Check if Word has application focus - if so, this is an internal focus change
    if (!_wordHasAppFocus) {
        // Word doesn't have app focus - this shouldn't happen as app observers handle external focus
        return;
    }

    // Internal focus change within Word - skip "change start", only trigger "change complete"

    // Cancel existing debounce timer
    [_focusChangeDebounceTimer invalidate];

    // Start new debounce timer to trigger change complete (for overlay position refresh)
    __weak typeof(self) weakSelf = self;
    _focusChangeDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:kScrollDebounceInterval
                                                                 repeats:NO
                                                                   block:^(NSTimer * _Nonnull timer) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf) {
            [strongSelf handleChangeComplete];
            strongSelf->_focusChangeDebounceTimer = nil;
        }
    }];
}

- (void)handleWindowMoveOrResize {
    // Guard: Don't process window move/resize if Word doesn't have focus
    if (!_wordHasAppFocus) {
        return;
    }

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
    // Guard: Don't process scroll events if Word doesn't have focus
    if (!_wordHasAppFocus) {
        return;
    }

    // Extract phase information from the scroll event
    NSEventPhase phase = event.phase;
    NSEventPhase momentumPhase = event.momentumPhase;

    // Track momentum state changes
    BOOL wasMomentumActive = _isMomentumScrollActive;

    // Update momentum tracking based on phases
    if (momentumPhase == NSEventPhaseBegan) {
        _isMomentumScrollActive = YES;
    } else if (momentumPhase == NSEventPhaseEnded || momentumPhase == NSEventPhaseCancelled) {
        _isMomentumScrollActive = NO;
    }

    // Store phase information for debugging
    _lastScrollPhase = phase;
    _lastMomentumPhase = momentumPhase;

    // === PHASE 1: DETECT SCROLL START (using event phases, not position) ===

    // Check if this is the beginning of a scroll gesture
    BOOL scrollStarting = NO;

    if (phase == NSEventPhaseBegan) {
        // Trackpad scroll started
        scrollStarting = YES;
    } else if (momentumPhase == NSEventPhaseBegan) {
        // Momentum phase started (shouldn't trigger new "change start")
    } else if (!_isScrolling && (phase == NSEventPhaseChanged || phase != NSEventPhaseNone)) {
        // First scroll event without explicit "Began" phase (some mice/trackpads)
        scrollStarting = YES;
    }

    // Trigger "change start" notification based on scroll gesture beginning
    if (scrollStarting && !_isChanging) {
        _isChanging = YES;
        _isScrolling = YES;

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
        _lastLayoutCornerPosition = currentLayoutCornerPosition;
        _hasLastLayoutCornerPosition = YES;

    } else if (!_hasLastLayoutCornerPosition && !CGPointEqualToPoint(currentLayoutCornerPosition, CGPointZero)) {
        // First scroll event - establish position baseline
        _lastLayoutCornerPosition = currentLayoutCornerPosition;
        _hasLastLayoutCornerPosition = YES;

    } else {
        // Position hasn't changed YET (Word's layout updating asynchronously)
        // Trust the scroll event and start debounce timer anyway
        // verifyPositionStableAndComplete will catch the position change later

        // Special case: momentum just ended
        if (!_isMomentumScrollActive && wasMomentumActive) {
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
        __weak typeof(self) weakSelf = self;
        _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:kScrollDebounceInterval
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
            typeof(self) strongSelf = weakSelf;
            if (strongSelf) {
                [strongSelf verifyPositionStableAndComplete];
                strongSelf->_scrollDebounceTimer = nil;
            }
        }];
    }
}

- (void)verifyPositionStableAndComplete {
    // Reset polling state
    [_textAreaBoundsHistory removeAllObjects];
    _pollingAttempts = 0;

    // Stop any existing polling timer
    [_positionPollingTimer invalidate];
    _positionPollingTimer = nil;

    // Start Phase 1: Lightweight polling
    [self startLightweightPolling];
}

- (void)startLightweightPolling {

    __weak typeof(self) weakSelf = self;
    _positionPollingTimer = [NSTimer scheduledTimerWithTimeInterval:kPollingInterval
                                                            repeats:YES
                                                              block:^(NSTimer * _Nonnull timer) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) {
            [timer invalidate];
            return;
        }

        [strongSelf pollTextAreaBounds];
    }];

    // Fire immediately for first sample
    [self pollTextAreaBounds];
}

- (void)pollTextAreaBounds {
    _pollingAttempts++;

    // Safety check: max polling duration exceeded
    if (_pollingAttempts > (kMaxPollingDuration / kPollingInterval)) {
        NSLog(@"[MicrosoftWordAdapter] WARNING: Max polling duration (%0.1fs) exceeded after %ld attempts - forcing completion",
              kMaxPollingDuration, (long)_pollingAttempts);
        [self stopPollingAndComplete];
        return;
    }

    // Get TextArea bounds (lightweight query)
    CGRect textAreaBounds = [self getTextAreaBounds];

    if (CGRectEqualToRect(textAreaBounds, CGRectZero)) {
        [self stopPollingAndComplete];
        return;
    }

    // Add to history
    [_textAreaBoundsHistory addObject:[NSValue valueWithRect:NSRectFromCGRect(textAreaBounds)]];

    // Keep only the required number of samples
    if (_textAreaBoundsHistory.count > kStabilitySampleCount) {
        [_textAreaBoundsHistory removeObjectAtIndex:0];
    }

    // Check if we have enough samples for stability check
    if (_textAreaBoundsHistory.count < kStabilitySampleCount) {
        return;
    }

    // Check if all samples are identical (position stable)
    BOOL allSamplesIdentical = YES;
    CGRect firstSample = NSRectToCGRect([_textAreaBoundsHistory[0] rectValue]);

    for (NSValue* sampleValue in _textAreaBoundsHistory) {
        CGRect sample = NSRectToCGRect([sampleValue rectValue]);
        if (!CGRectEqualToRect(sample, firstSample)) {
            allSamplesIdentical = NO;
            break;
        }
    }

    if (allSamplesIdentical) {
        [self stopPollingAndComplete];
    }
}

- (void)stopPollingAndComplete {
    // Stop polling timer
    [_positionPollingTimer invalidate];
    _positionPollingTimer = nil;

    // Phase 2: Perform expensive layout bounds calculation once
    CGRect layoutBounds = [self getLayoutBounds];

    if (!CGRectEqualToRect(layoutBounds, CGRectZero)) {
        _lastLayoutCornerPosition = layoutBounds.origin;
        _hasLastLayoutCornerPosition = YES;
    }

    // Complete the change
    [self handleChangeComplete];
    _isScrolling = NO;
}

- (void)handleChangeComplete {
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

    // Query fresh scroll area bounds
    CGRect scrollBounds = [self queryScrollAreaBounds];

    // Update cache
    if (!CGRectEqualToRect(scrollBounds, CGRectZero)) {
        _cachedScrollAreaBounds = scrollBounds;
        _lastScrollAreaUpdate = [[NSDate date] timeIntervalSince1970];
    }

    return scrollBounds;
}

- (CGRect)queryScrollAreaBounds {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: FAILED - No focused element (error: %d)", error);
        return CGRectZero;
    }

    // Walk up parent hierarchy to find AXScrollArea at level 4
    NSMutableArray* hierarchy = [NSMutableArray array];
    AXUIElementRef currentElement = focusedElement;
    CFRetain(currentElement);

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
    for (NSDictionary* item in hierarchy) {
        if ([item[@"role"] isEqualToString:(__bridge NSString*)kAXScrollAreaRole]) {

            // Get the bounds of the scroll area
            CGPoint position = NSPointToCGPoint([item[@"position"] pointValue]);
            CGSize size = NSSizeToCGSize([item[@"size"] sizeValue]);

            // Verify that the scroll area has valid (non-zero) dimensions
            if (size.width > 0 && size.height > 0) {
                CGRect result = CGRectMake(position.x, position.y, size.width, size.height);
                return result;
            }
        }
    }

    // Fallback: Find AXWindow in hierarchy and use the element directly below it
    // This handles cases where there's no explicit AXScrollArea but the content area
    // is represented by a split group or group element
    int windowLevel = -1;
    for (NSDictionary* item in hierarchy) {
        if ([item[@"role"] isEqualToString:(__bridge NSString*)kAXWindowRole]) {
            windowLevel = [item[@"level"] intValue];
            break;
        }
    }

    if (windowLevel > 0) {
        // Get the element one level below the window (windowLevel - 1)
        int targetLevel = windowLevel - 1;
        for (NSDictionary* item in hierarchy) {
            if ([item[@"level"] intValue] == targetLevel) {
                CGPoint position = NSPointToCGPoint([item[@"position"] pointValue]);
                CGSize size = NSSizeToCGSize([item[@"size"] sizeValue]);

                if (size.width > 0 && size.height > 0) {
                    CGRect result = CGRectMake(position.x, position.y, size.width, size.height);
                    return result;
                }
                break;
            }
        }
    }

    NSLog(@"[MicrosoftWordAdapter] queryScrollAreaBounds: FAILED - No valid scroll area or fallback element found");
    return CGRectZero;
}

- (CGRect)getLayoutBounds {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return CGRectZero;
    }

    // Strategy: Find AXTextArea in hierarchy, then get position AND size 2 levels up from it
    AXUIElementRef currentElement = focusedElement;
    CFRetain(currentElement);
    AXUIElementRef layoutElement = NULL;

    // Walk up the hierarchy looking for AXTextArea
    for (int i = 0; i < 20; i++) {
        // Get role
        CFTypeRef roleValue = NULL;
        AXUIElementCopyAttributeValue(currentElement, kAXRoleAttribute, &roleValue);
        NSString* role = (__bridge_transfer NSString*)roleValue;

        // Check if this is the text area
        if ([role isEqualToString:(__bridge NSString*)kAXTextAreaRole]) {
            // Need to go up 3 more levels to get the layout element
            // Continue walking to get 3 levels up
            for (int j = 0; j < 3; j++) {
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
            layoutElement = currentElement;
            CFRetain(layoutElement);  // Retain so we can use it after cleanup
            break;
        }

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

    // Clean up current element
    if (currentElement != focusedElement) {
        CFRelease(currentElement);
    }
    CFRelease(focusedElement);

    // If we found the layout element, find the child with smallest Y value
    if (layoutElement) {
        // Get all children
        CFTypeRef childrenValue = NULL;
        error = AXUIElementCopyAttributeValue(layoutElement, kAXChildrenAttribute, &childrenValue);

        if (error == kAXErrorSuccess && childrenValue) {
            NSArray* children = (__bridge_transfer NSArray*)childrenValue;

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
                return result;
            }
        } else {
            CFRelease(layoutElement);
        }
    }

    return CGRectZero;
}

- (CGRect)getTextAreaBounds {
    // Lightweight bounds query for TextArea element only
    // Used for polling-based scroll completion detection
    // Much faster than getLayoutBounds as it doesn't traverse the hierarchy

    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return CGRectZero;
    }

    // Walk up to find AXTextArea
    AXUIElementRef currentElement = focusedElement;
    CFRetain(currentElement);
    CGRect textAreaBounds = CGRectZero;

    for (int i = 0; i < 20; i++) {
        // Get role
        CFTypeRef roleValue = NULL;
        AXUIElementCopyAttributeValue(currentElement, kAXRoleAttribute, &roleValue);
        NSString* role = (__bridge_transfer NSString*)roleValue;

        // Check if this is the text area
        if ([role isEqualToString:(__bridge NSString*)kAXTextAreaRole]) {
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
            error = AXUIElementCopyAttributeValue(currentElement, kAXSizeAttribute, &sizeValue);
            CGSize size = CGSizeZero;
            if (error == kAXErrorSuccess && sizeValue) {
                AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size);
                CFRelease(sizeValue);
            }

            textAreaBounds = CGRectMake(position.x, position.y, size.width, size.height);
            break;
        }

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

    return textAreaBounds;
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

- (CGRect)findTextPosition:(NSString*)searchText {
    if (!searchText || searchText.length == 0) {
        NSLog(@"[MicrosoftWordAdapter] ERROR: Empty search text");
        return CGRectZero;
    }

    // Get focused element (must be AXTextArea)
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        NSLog(@"[MicrosoftWordAdapter] ERROR: Could not get focused element (error: %d)", error);
        return CGRectZero;
    }

    // Get the full text content
    CFTypeRef textValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXValueAttribute, &textValue);

    if (error != kAXErrorSuccess || !textValue) {
        NSLog(@"[MicrosoftWordAdapter] ERROR: Could not get text value (error: %d)", error);
        CFRelease(focusedElement);
        return CGRectZero;
    }

    NSString* fullText = (__bridge_transfer NSString*)textValue;

    // Search for the text
    NSRange searchRange = [fullText rangeOfString:searchText options:0];
    if (searchRange.location == NSNotFound) {
        CFRelease(focusedElement);
        return CGRectZero;
    }

    // Get bounds for this text range using AXBoundsForRangeParameterizedAttribute
    CFRange range = CFRangeMake(searchRange.location, searchRange.length);
    AXValueRef rangeValue = AXValueCreate(kAXValueTypeCFRange, &range);

    if (!rangeValue) {
        NSLog(@"[MicrosoftWordAdapter] ERROR: Could not create range value");
        CFRelease(focusedElement);
        return CGRectZero;
    }

    CFTypeRef boundsValue = NULL;
    error = AXUIElementCopyParameterizedAttributeValue(focusedElement,
                                                       kAXBoundsForRangeParameterizedAttribute,
                                                       rangeValue,
                                                       &boundsValue);

    CGRect bounds = CGRectZero;
    if (error == kAXErrorSuccess && boundsValue) {
        AXValueGetValue((AXValueRef)boundsValue, (AXValueType)kAXValueTypeCGRect, &bounds);
        CFRelease(boundsValue);
    } else {
        NSLog(@"[MicrosoftWordAdapter] ERROR: Could not get bounds (error: %d)", error);
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
    }
}

@end

#pragma mark - Accessibility Callback

static void WordAdapterAccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon) {
    MicrosoftWordAdapter* adapter = (__bridge MicrosoftWordAdapter*)refcon;
    NSString* notificationName = (__bridge NSString*)notification;

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
