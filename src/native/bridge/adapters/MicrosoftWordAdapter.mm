//
//  MicrosoftWordAdapter.mm
//  AcademiaElectron
//
//  Implementation of Microsoft Word position tracking adapter
//

#import "MicrosoftWordAdapter.h"

// Configuration constants
static const NSTimeInterval kScrollDebounceInterval = 0.3;      // 300ms
static const NSTimeInterval kWindowMoveDebounceInterval = 0.5;  // 500ms
static const NSTimeInterval kBoundsCacheValidityDuration = 1.0; // 1 second
static const NSTimeInterval kScrollAreaCacheValidityDuration = 2.0; // 2 seconds

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

    // Position tracking for scroll detection
    CGPoint _lastLayoutCornerPosition;
    BOOL _hasLastLayoutCornerPosition;

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

        // Initialize caches
        _cachedWordBounds = CGRectZero;
        _lastBoundsUpdate = 0;
        _cachedScrollAreaBounds = CGRectZero;
        _lastScrollAreaUpdate = 0;

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
            // Call handleScrollEvent on main queue
            dispatch_async(dispatch_get_main_queue(), ^{
                [strongSelf handleScrollEvent];
            });
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
    // Update caches immediately on activation
    [self updateCachedWordBounds];
    [self invalidateScrollAreaCache];

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

- (void)handleScrollEvent {
    CGPoint currentLayoutCornerPosition = [self getLayoutBounds].origin;

    // Check if position actually changed
    if (_hasLastLayoutCornerPosition &&
        !CGPointEqualToPoint(currentLayoutCornerPosition, CGPointZero) &&
        !CGPointEqualToPoint(currentLayoutCornerPosition, _lastLayoutCornerPosition)) {

        NSLog(@"[MicrosoftWordAdapter] Scroll detected: (%.1f, %.1f) -> (%.1f, %.1f)",
              _lastLayoutCornerPosition.x, _lastLayoutCornerPosition.y,
              currentLayoutCornerPosition.x, currentLayoutCornerPosition.y);

        // Mark as changing if not already
        if (!_isChanging) {
            _isChanging = YES;
            _isScrolling = YES;

            // Notify delegate: change started
            if (_delegate) {
                [_delegate wordAdapterDidStartChanging:self];
            }
        }

        // Cancel existing scroll debounce timer
        [_scrollDebounceTimer invalidate];

        // Start new debounce timer
        __weak typeof(self) weakSelf = self;
        _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:kScrollDebounceInterval
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
            typeof(self) strongSelf = weakSelf;
            if (strongSelf) {
                [strongSelf handleChangeComplete];
                strongSelf->_scrollDebounceTimer = nil;
                strongSelf->_isScrolling = NO;
            }
        }];
    }

    // Update last position
    if (!CGPointEqualToPoint(currentLayoutCornerPosition, CGPointZero)) {
        _lastLayoutCornerPosition = currentLayoutCornerPosition;
        _hasLastLayoutCornerPosition = YES;
    }
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
    // Return cached bounds if still valid
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    if (!CGRectEqualToRect(_cachedScrollAreaBounds, CGRectZero) &&
        (now - _lastScrollAreaUpdate) < kScrollAreaCacheValidityDuration) {
        return _cachedScrollAreaBounds;
    }

    // Query fresh scroll area bounds
    CGRect scrollBounds = [self queryScrollAreaBounds];

    // Update cache
    if (!CGRectEqualToRect(scrollBounds, CGRectZero)) {
        _cachedScrollAreaBounds = scrollBounds;
        _lastScrollAreaUpdate = now;
    }

    return scrollBounds;
}

- (CGRect)queryScrollAreaBounds {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
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

    // Find AXTextArea in hierarchy (should be at level 0)
    int textAreaLevel = -1;
    for (NSDictionary* item in hierarchy) {
        if ([item[@"role"] isEqualToString:(__bridge NSString*)kAXTextAreaRole]) {
            textAreaLevel = [item[@"level"] intValue];
            break;
        }
    }

    // If we found AXTextArea at level 0, check if level 4 parent is an AXScrollArea
    if (textAreaLevel == 0) {
        NSUInteger scrollAreaLevel = 4;
        if (scrollAreaLevel < hierarchy.count) {
            NSDictionary* scrollItem = hierarchy[scrollAreaLevel];
            NSString* scrollRole = scrollItem[@"role"];

            if ([scrollRole isEqualToString:(__bridge NSString*)kAXScrollAreaRole]) {
                CGPoint position = NSPointToCGPoint([scrollItem[@"position"] pointValue]);
                CGSize size = NSSizeToCGSize([scrollItem[@"size"] sizeValue]);
                return CGRectMake(position.x, position.y, size.width, size.height);
            }
        }
    }

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
    int textAreaLevel = -1;

    // Walk up the hierarchy looking for AXTextArea
    for (int i = 0; i < 20; i++) {
        // Get role
        CFTypeRef roleValue = NULL;
        AXUIElementCopyAttributeValue(currentElement, kAXRoleAttribute, &roleValue);
        NSString* role = (__bridge_transfer NSString*)roleValue;

        // Check if this is the text area
        if ([role isEqualToString:(__bridge NSString*)kAXTextAreaRole]) {
            textAreaLevel = i;
            // Need to go up 2 more levels to get the layout element
            // Continue walking to get 2 levels up
            for (int j = 0; j < 2; j++) {
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

    // If we found the layout element, get its position and size
    if (layoutElement) {
        CGPoint position = CGPointZero;
        CGSize size = CGSizeZero;

        // Get position
        CFTypeRef positionValue = NULL;
        error = AXUIElementCopyAttributeValue(layoutElement, kAXPositionAttribute, &positionValue);
        if (error == kAXErrorSuccess && positionValue) {
            AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position);
            CFRelease(positionValue);
        }

        // Get size
        CFTypeRef sizeValue = NULL;
        error = AXUIElementCopyAttributeValue(layoutElement, kAXSizeAttribute, &sizeValue);
        if (error == kAXErrorSuccess && sizeValue) {
            AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size);
            CFRelease(sizeValue);
        }

        CFRelease(layoutElement);
        return CGRectMake(position.x, position.y, size.width, size.height);
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
    }
}
