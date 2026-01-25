#import "WindowMonitor.h"

@interface WindowMonitor ()

@property (nonatomic, assign) AXObserverRef axObserver;
@property (nonatomic, assign) AXUIElementRef wordAppElement;
@property (nonatomic, assign) pid_t wordPid;
@property (nonatomic, strong) NSMutableSet<NSNumber *> *trackedWindowIds;      // Windows we emitted CREATED/EXISTING for (role=AXWindow)
@property (nonatomic, strong) NSMutableSet<NSNumber *> *allKnownWindowIds;     // All Word windows (for destroy detection)
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSValue *> *windowBoundsCache;  // Cached bounds for resize detection
@property (nonatomic, assign) AXUIElementRef observedWindowElement;                          // Window with resize observers attached
@property (nonatomic, assign) BOOL isResizing;                                               // Whether focused window is currently resizing
@property (nonatomic, strong) NSDate *lastBoundsChangeTime;                                  // Last bounds change timestamp for focused window
@property (nonatomic, strong) NSTimer *pollingTimer;                           // Periodic check for missed events
@property (nonatomic, strong) NSTimer *resizeEndTimer;                         // Timer to detect resize end
@property (nonatomic, assign) CGWindowID lastFocusedWindowId;                  // Track last focused window for polling
@property (nonatomic, assign) BOOL isMonitoring;

@end

@implementation WindowMonitor

#pragma mark - Initialization

- (instancetype)initWithBundleId:(NSString *)bundleId {
    self = [super init];
    if (self) {
        _targetBundleId = [bundleId copy] ?: [kDefaultBundleId copy];
        _appDisplayName = nil;  // Will be auto-detected when app is found
        _trackedWindowIds = [NSMutableSet set];
        _allKnownWindowIds = [NSMutableSet set];
        _windowBoundsCache = [NSMutableDictionary dictionary];
        _observedWindowElement = NULL;
        _isResizing = NO;
        _lastBoundsChangeTime = nil;
        _wordPid = 0;
        _lastFocusedWindowId = 0;
        _isMonitoring = NO;
    }
    return self;
}

- (instancetype)init {
    return [self initWithBundleId:kDefaultBundleId];
}

#pragma mark - Accessibility Permissions

+ (BOOL)hasAccessibilityPermission {
    return AXIsProcessTrusted();
}

+ (void)requestAccessibilityPermission {
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
    AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

#pragma mark - Monitoring Control

- (void)startMonitoring {
    if (self.isMonitoring) {
        return;
    }

    self.isMonitoring = YES;
    NSLog(@"Starting window monitor for %@...", self.targetBundleId);

    // Register for app launch/termination notifications
    [[[NSWorkspace sharedWorkspace] notificationCenter] addObserver:self
                                                           selector:@selector(appDidLaunch:)
                                                               name:NSWorkspaceDidLaunchApplicationNotification
                                                             object:nil];

    [[[NSWorkspace sharedWorkspace] notificationCenter] addObserver:self
                                                           selector:@selector(appDidTerminate:)
                                                               name:NSWorkspaceDidTerminateApplicationNotification
                                                             object:nil];

    [[[NSWorkspace sharedWorkspace] notificationCenter] addObserver:self
                                                           selector:@selector(appDidActivate:)
                                                               name:NSWorkspaceDidActivateApplicationNotification
                                                             object:nil];

    [[[NSWorkspace sharedWorkspace] notificationCenter] addObserver:self
                                                           selector:@selector(appDidDeactivate:)
                                                               name:NSWorkspaceDidDeactivateApplicationNotification
                                                             object:nil];

    // Check if target app is already running
    NSArray<NSRunningApplication *> *runningApps = [[NSWorkspace sharedWorkspace] runningApplications];
    for (NSRunningApplication *app in runningApps) {
        if ([app.bundleIdentifier isEqualToString:self.targetBundleId]) {
            [self updateAppDisplayNameFromApp:app];
            NSLog(@"%@ is already running (PID: %d)", self.appDisplayName, app.processIdentifier);
            // Emit APP_EXISTING before WINDOW_EXISTING events
            self.wordPid = app.processIdentifier;
            [self emitAppEvent:WindowEventTypeAppExisting];
            [self attachToApp:app];
            break;
        }
    }
}

- (void)stopMonitoring {
    if (!self.isMonitoring) {
        return;
    }

    self.isMonitoring = NO;
    NSLog(@"Stopping window monitor...");

    // Remove workspace notifications
    [[[NSWorkspace sharedWorkspace] notificationCenter] removeObserver:self];

    // Clean up AXObserver
    [self detachFromApp];
}

#pragma mark - App Notifications

- (void)appDidLaunch:(NSNotification *)notification {
    NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
    if ([app.bundleIdentifier isEqualToString:self.targetBundleId]) {
        [self updateAppDisplayNameFromApp:app];
        NSLog(@"%@ launched (PID: %d)", self.appDisplayName, app.processIdentifier);
        // Emit APP_LAUNCHED before WINDOW_EXISTING events
        self.wordPid = app.processIdentifier;
        [self emitAppEvent:WindowEventTypeAppLaunched];
        [self attachToApp:app];
    }
}

- (void)appDidTerminate:(NSNotification *)notification {
    NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
    if ([app.bundleIdentifier isEqualToString:self.targetBundleId]) {
        NSLog(@"%@ terminated", self.appDisplayName);

        // Emit destroyed events for all tracked windows
        [self emitDestroyedEventsForAllTrackedWindows];
        [self emitAppEvent:WindowEventTypeAppTerminated];
        [self detachFromApp];
    }
}

- (void)appDidActivate:(NSNotification *)notification {
    NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
    if ([app.bundleIdentifier isEqualToString:self.targetBundleId]) {
        [self emitAppEvent:WindowEventTypeAppFocused];
    }
}

- (void)appDidDeactivate:(NSNotification *)notification {
    NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
    if ([app.bundleIdentifier isEqualToString:self.targetBundleId]) {
        [self emitAppEvent:WindowEventTypeAppUnfocused];
    }
}

- (void)updateAppDisplayNameFromApp:(NSRunningApplication *)app {
    if (!self.appDisplayName && app.localizedName) {
        self.appDisplayName = app.localizedName;
    } else if (!self.appDisplayName) {
        // Fallback to bundle ID if no localized name available
        self.appDisplayName = self.targetBundleId;
    }
}

- (void)emitAppEvent:(WindowEventType)eventType {
    AppInfo *appInfo = [[AppInfo alloc] initWithName:self.appDisplayName ?: self.targetBundleId
                                          identifier:self.targetBundleId
                                      identifierType:@"bundleId"
                                                 pid:self.wordPid];

    WindowEvent *event = [[WindowEvent alloc] initWithEventType:eventType
                                                            app:appInfo
                                                         window:nil];
    NSString *json = [event toAppJSON];
    printf("%s\n", [json UTF8String]);
    fflush(stdout);
}

#pragma mark - App Attachment

- (void)attachToApp:(NSRunningApplication *)app {
    self.wordPid = app.processIdentifier;

    // Create AXUIElement for target app
    self.wordAppElement = AXUIElementCreateApplication(self.wordPid);
    if (!self.wordAppElement) {
        NSLog(@"Failed to create AXUIElement for %@", self.appDisplayName);
        return;
    }

    // Create AXObserver
    AXError error = AXObserverCreate(self.wordPid, axObserverCallback, &_axObserver);
    if (error != kAXErrorSuccess) {
        NSLog(@"Failed to create AXObserver: %d", error);
        CFRelease(self.wordAppElement);
        self.wordAppElement = NULL;
        return;
    }

    // Add notifications
    AXObserverAddNotification(self.axObserver, self.wordAppElement,
                              kAXWindowCreatedNotification,
                              (__bridge void *)self);

    AXObserverAddNotification(self.axObserver, self.wordAppElement,
                              kAXUIElementDestroyedNotification,
                              (__bridge void *)self);

    AXObserverAddNotification(self.axObserver, self.wordAppElement,
                              kAXFocusedWindowChangedNotification,
                              (__bridge void *)self);

    // Add to run loop
    CFRunLoopAddSource(CFRunLoopGetCurrent(),
                       AXObserverGetRunLoopSource(self.axObserver),
                       kCFRunLoopDefaultMode);

    NSLog(@"Attached to %@, observing window events...", self.appDisplayName);

    // Enumerate existing windows
    [self enumerateExistingWindows];

    // Start periodic polling to catch any missed events
    self.pollingTimer = [NSTimer scheduledTimerWithTimeInterval:0.2
                                                         target:self
                                                       selector:@selector(pollForChanges)
                                                       userInfo:nil
                                                        repeats:YES];
}

- (void)pollForChanges {
    [self checkForWindowChanges];
    [self checkForFocusChange];
    [self checkForBoundsChange];  // Poll for bounds changes (detects programmatic moves)
}

- (void)detachFromApp {
    // Stop timers
    if (self.pollingTimer) {
        [self.pollingTimer invalidate];
        self.pollingTimer = nil;
    }
    if (self.resizeEndTimer) {
        [self.resizeEndTimer invalidate];
        self.resizeEndTimer = nil;
    }

    // Unregister resize observers from focused window
    [self unregisterResizeObservers];

    if (self.axObserver) {
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(),
                              AXObserverGetRunLoopSource(self.axObserver),
                              kCFRunLoopDefaultMode);
        CFRelease(self.axObserver);
        self.axObserver = NULL;
    }

    if (self.wordAppElement) {
        CFRelease(self.wordAppElement);
        self.wordAppElement = NULL;
    }

    self.wordPid = 0;
    self.isResizing = NO;
    self.lastBoundsChangeTime = nil;
    [self.trackedWindowIds removeAllObjects];
    [self.allKnownWindowIds removeAllObjects];
    [self.windowBoundsCache removeAllObjects];
}

#pragma mark - Resize Observer Management

- (void)registerResizeObserversForWindow:(AXUIElementRef)windowElement {
    if (!self.axObserver || !windowElement) {
        return;
    }

    // Unregister from previous window first
    [self unregisterResizeObservers];

    // Register for move and resize notifications on this window
    AXObserverAddNotification(self.axObserver, windowElement,
                              kAXMovedNotification,
                              (__bridge void *)self);

    AXObserverAddNotification(self.axObserver, windowElement,
                              kAXResizedNotification,
                              (__bridge void *)self);

    self.observedWindowElement = windowElement;
    CFRetain(self.observedWindowElement);
}

- (void)unregisterResizeObservers {
    if (self.observedWindowElement && self.axObserver) {
        AXObserverRemoveNotification(self.axObserver, self.observedWindowElement,
                                     kAXMovedNotification);
        AXObserverRemoveNotification(self.axObserver, self.observedWindowElement,
                                     kAXResizedNotification);
        CFRelease(self.observedWindowElement);
        self.observedWindowElement = NULL;
    }

    // If we were resizing, emit the final RESIZED event
    if (self.isResizing) {
        [self finishResizing];
    }
}

#pragma mark - Window Enumeration

- (void)enumerateExistingWindows {
    NSArray<NSDictionary *> *windows = [self getWordWindows];
    NSUInteger emittedCount = 0;

    for (NSDictionary *windowDict in windows) {
        CGWindowID windowId = [windowDict[(__bridge id)kCGWindowNumber] unsignedIntValue];

        // Track ALL windows for destroy detection
        [self.allKnownWindowIds addObject:@(windowId)];

        // Only emit WINDOW_EXISTING for windows with role "AXWindow"
        CGRect bounds = CGRectZero;
        CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)windowDict[(__bridge id)kCGWindowBounds],
            &bounds
        );

        NSString *role = [self getRoleForWindowAtBounds:bounds];
        if (![role isEqualToString:@"AXWindow"]) {
            continue;
        }

        [self.trackedWindowIds addObject:@(windowId)];
        // Cache initial bounds for resize detection
        self.windowBoundsCache[@(windowId)] = [NSValue valueWithRect:bounds];
        emittedCount++;

        WindowEvent *event = [self createEventFromWindowDict:windowDict eventType:WindowEventTypeInitial];
        [self emitEvent:event];
    }

    NSLog(@"Found %lu %@ windows, emitted %lu WINDOW_EXISTING events", (unsigned long)windows.count, self.appDisplayName, (unsigned long)emittedCount);
}

- (NSArray<NSDictionary *> *)getWordWindows {
    if (self.wordPid == 0) {
        return @[];
    }

    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );

    if (!windowList) {
        return @[];
    }

    NSMutableArray<NSDictionary *> *wordWindows = [NSMutableArray array];
    NSArray *windows = (__bridge_transfer NSArray *)windowList;

    for (NSDictionary *window in windows) {
        pid_t windowPid = [window[(__bridge id)kCGWindowOwnerPID] intValue];
        if (windowPid == self.wordPid) {
            // Filter out windows with no name or very small windows (like cursors)
            NSString *windowName = window[(__bridge id)kCGWindowName];
            CGRect bounds;
            CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)window[(__bridge id)kCGWindowBounds],
                &bounds
            );

            // Include windows with names or reasonable size
            if (windowName.length > 0 || (bounds.size.width > 50 && bounds.size.height > 50)) {
                [wordWindows addObject:window];
            }
        }
    }

    return wordWindows;
}

#pragma mark - AXObserver Callback

static void axObserverCallback(AXObserverRef observer,
                                AXUIElementRef element,
                                CFStringRef notificationName,
                                void *contextData) {
    WindowMonitor *monitor = (__bridge WindowMonitor *)contextData;
    NSString *notification = (__bridge NSString *)notificationName;

    if ([notification isEqualToString:(__bridge NSString *)kAXWindowCreatedNotification]) {
        [monitor handleWindowCreated:element];
    } else if ([notification isEqualToString:(__bridge NSString *)kAXUIElementDestroyedNotification]) {
        [monitor handleWindowDestroyed:element];
    } else if ([notification isEqualToString:(__bridge NSString *)kAXFocusedWindowChangedNotification]) {
        // Emit focus event and also check for window changes
        [monitor handleFocusChanged];
        [monitor checkForWindowChanges];
    } else if ([notification isEqualToString:(__bridge NSString *)kAXMovedNotification] ||
               [notification isEqualToString:(__bridge NSString *)kAXResizedNotification]) {
        [monitor handleWindowBoundsChanged:element];
    }
}

#pragma mark - Window Event Handlers

- (void)handleWindowCreated:(AXUIElementRef)windowElement {
    // Small delay to allow window to fully initialize
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [self checkForWindowChanges];
    });
}

- (void)handleWindowDestroyed:(AXUIElementRef)windowElement {
    // Check for destroyed windows
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [self checkForWindowChanges];
    });
}

- (void)handleFocusChanged {
    [self checkForFocusChange];
}

- (void)handleWindowBoundsChanged:(AXUIElementRef)windowElement {
    // Cancel any pending resize end timer
    if (self.resizeEndTimer) {
        [self.resizeEndTimer invalidate];
        self.resizeEndTimer = nil;
    }

    // If not already resizing, emit WINDOW_RESIZING
    if (!self.isResizing) {
        self.isResizing = YES;

        // Find the window and emit RESIZING event
        [self emitResizingEventForFocusedWindow];
    }

    // Update last change time
    self.lastBoundsChangeTime = [NSDate date];

    // Schedule timer to detect when resizing stops
    self.resizeEndTimer = [NSTimer scheduledTimerWithTimeInterval:0.15
                                                           target:self
                                                         selector:@selector(checkResizeEnd)
                                                         userInfo:nil
                                                          repeats:NO];
}

- (void)checkResizeEnd {
    self.resizeEndTimer = nil;

    // If enough time passed since last bounds change, resize is done
    if (self.isResizing && self.lastBoundsChangeTime) {
        NSTimeInterval elapsed = [[NSDate date] timeIntervalSinceDate:self.lastBoundsChangeTime];
        if (elapsed >= 0.1) {
            [self finishResizing];
        }
    }
}

- (void)finishResizing {
    if (!self.isResizing) {
        return;
    }

    self.isResizing = NO;
    self.lastBoundsChangeTime = nil;

    // Emit WINDOW_RESIZED event with final bounds
    [self emitResizedEventForFocusedWindow];
}

- (void)emitResizingEventForFocusedWindow {
    if (self.lastFocusedWindowId == 0) {
        return;
    }

    NSArray<NSDictionary *> *windows = [self getWordWindows];
    for (NSDictionary *windowDict in windows) {
        CGWindowID windowId = [windowDict[(__bridge id)kCGWindowNumber] unsignedIntValue];
        if (windowId == self.lastFocusedWindowId) {
            WindowEvent *event = [self createEventFromWindowDict:windowDict
                                                       eventType:WindowEventTypeRepositioning];
            [self emitEvent:event];
            break;
        }
    }
}

- (void)emitResizedEventForFocusedWindow {
    if (self.lastFocusedWindowId == 0) {
        return;
    }

    NSArray<NSDictionary *> *windows = [self getWordWindows];
    for (NSDictionary *windowDict in windows) {
        CGWindowID windowId = [windowDict[(__bridge id)kCGWindowNumber] unsignedIntValue];
        if (windowId == self.lastFocusedWindowId) {
            // Update cached bounds
            CGRect bounds = CGRectZero;
            CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)windowDict[(__bridge id)kCGWindowBounds],
                &bounds
            );
            self.windowBoundsCache[@(windowId)] = [NSValue valueWithRect:bounds];

            WindowEvent *event = [self createEventFromWindowDict:windowDict
                                                       eventType:WindowEventTypeRepositioned];
            [self emitEvent:event];
            break;
        }
    }
}

- (void)checkForFocusChange {
    if (!self.wordAppElement) {
        return;
    }

    // Only emit focus events if target app is the frontmost application
    NSRunningApplication *frontmost = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (![frontmost.bundleIdentifier isEqualToString:self.targetBundleId]) {
        return;
    }

    // Get the focused window
    CFTypeRef focusedWindowRef = NULL;
    AXError error = AXUIElementCopyAttributeValue(self.wordAppElement, kAXFocusedWindowAttribute, &focusedWindowRef);
    if (error != kAXErrorSuccess || !focusedWindowRef) {
        return;
    }

    AXUIElementRef focusedWindow = (AXUIElementRef)focusedWindowRef;

    // Get position of focused window
    CFTypeRef positionValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedWindow, kAXPositionAttribute, &positionValue);
    if (error != kAXErrorSuccess || !positionValue) {
        CFRelease(focusedWindow);
        return;
    }

    CGPoint position;
    if (!AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position)) {
        CFRelease(positionValue);
        CFRelease(focusedWindow);
        return;
    }
    CFRelease(positionValue);

    // Get size of focused window
    CFTypeRef sizeValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedWindow, kAXSizeAttribute, &sizeValue);
    if (error != kAXErrorSuccess || !sizeValue) {
        CFRelease(focusedWindow);
        return;
    }

    CGSize size;
    if (!AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size)) {
        CFRelease(sizeValue);
        CFRelease(focusedWindow);
        return;
    }
    CFRelease(sizeValue);

    CGRect focusedBounds = CGRectMake(position.x, position.y, size.width, size.height);

    // Find matching CGWindow to get window ID
    NSArray<NSDictionary *> *windows = [self getWordWindows];
    for (NSDictionary *windowDict in windows) {
        CGRect bounds = CGRectZero;
        CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)windowDict[(__bridge id)kCGWindowBounds],
            &bounds
        );

        CGFloat tolerance = 2.0;
        if (fabs(bounds.origin.x - focusedBounds.origin.x) < tolerance &&
            fabs(bounds.origin.y - focusedBounds.origin.y) < tolerance &&
            fabs(bounds.size.width - focusedBounds.size.width) < tolerance &&
            fabs(bounds.size.height - focusedBounds.size.height) < tolerance) {

            CGWindowID windowId = [windowDict[(__bridge id)kCGWindowNumber] unsignedIntValue];

            // Only emit if focus actually changed
            if (windowId != self.lastFocusedWindowId) {
                self.lastFocusedWindowId = windowId;

                // Register resize observers on the newly focused window
                [self registerResizeObserversForWindow:focusedWindow];

                WindowEvent *event = [self createEventFromWindowDict:windowDict eventType:WindowEventTypeFocused];
                [self emitEvent:event];
            }
            break;
        }
    }

    CFRelease(focusedWindow);
}

- (void)checkForBoundsChange {
    if (self.lastFocusedWindowId == 0) {
        return;
    }

    NSArray<NSDictionary *> *windows = [self getWordWindows];
    for (NSDictionary *windowDict in windows) {
        CGWindowID windowId = [windowDict[(__bridge id)kCGWindowNumber] unsignedIntValue];
        if (windowId != self.lastFocusedWindowId) {
            continue;
        }

        CGRect currentBounds = CGRectZero;
        CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)windowDict[(__bridge id)kCGWindowBounds],
            &currentBounds
        );

        NSValue *cachedValue = self.windowBoundsCache[@(windowId)];
        if (!cachedValue) {
            // No cached bounds, cache current and return
            self.windowBoundsCache[@(windowId)] = [NSValue valueWithRect:currentBounds];
            return;
        }

        CGRect cachedBounds = [cachedValue rectValue];
        CGFloat tolerance = 2.0;

        BOOL boundsChanged =
            fabs(currentBounds.origin.x - cachedBounds.origin.x) > tolerance ||
            fabs(currentBounds.origin.y - cachedBounds.origin.y) > tolerance ||
            fabs(currentBounds.size.width - cachedBounds.size.width) > tolerance ||
            fabs(currentBounds.size.height - cachedBounds.size.height) > tolerance;

        if (boundsChanged) {
            // Trigger repositioning flow (same as AX callback)
            [self handleWindowBoundsChanged:NULL];
        }
        break;
    }
}

- (void)checkForWindowChanges {
    NSArray<NSDictionary *> *currentWindows = [self getWordWindows];
    NSMutableSet<NSNumber *> *currentWindowIds = [NSMutableSet set];

    // Check for new windows
    for (NSDictionary *windowDict in currentWindows) {
        CGWindowID windowId = [windowDict[(__bridge id)kCGWindowNumber] unsignedIntValue];
        [currentWindowIds addObject:@(windowId)];

        // Track ALL new windows for destroy detection
        BOOL isNewWindow = ![self.allKnownWindowIds containsObject:@(windowId)];
        if (isNewWindow) {
            [self.allKnownWindowIds addObject:@(windowId)];
        }

        // Only emit WINDOW_CREATED for windows with role "AXWindow" that we haven't emitted for yet
        if (![self.trackedWindowIds containsObject:@(windowId)]) {
            CGRect bounds = CGRectZero;
            CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)windowDict[(__bridge id)kCGWindowBounds],
                &bounds
            );

            NSString *role = [self getRoleForWindowAtBounds:bounds];
            if ([role isEqualToString:@"AXWindow"]) {
                [self.trackedWindowIds addObject:@(windowId)];
                // Cache initial bounds for resize detection
                self.windowBoundsCache[@(windowId)] = [NSValue valueWithRect:bounds];
                WindowEvent *event = [self createEventFromWindowDict:windowDict eventType:WindowEventTypeCreated];
                [self emitEvent:event];
            }
        }
    }

    // Check for destroyed windows - emit for ALL windows that disappeared (no filtering)
    NSMutableSet<NSNumber *> *destroyedWindowIds = [self.allKnownWindowIds mutableCopy];
    [destroyedWindowIds minusSet:currentWindowIds];

    for (NSNumber *windowId in destroyedWindowIds) {
        [self.allKnownWindowIds removeObject:windowId];
        [self.trackedWindowIds removeObject:windowId];  // Also remove from tracked if present
        [self.windowBoundsCache removeObjectForKey:windowId];  // Clean up bounds cache
        [self emitDestroyedEventForWindowId:[windowId unsignedIntValue]];
    }
}

- (void)emitDestroyedEventsForAllTrackedWindows {
    // Emit destroy events for ALL known windows (not just tracked ones)
    for (NSNumber *windowId in self.allKnownWindowIds) {
        [self emitDestroyedEventForWindowId:[windowId unsignedIntValue]];
    }
    [self.allKnownWindowIds removeAllObjects];
    [self.trackedWindowIds removeAllObjects];
}

- (void)emitDestroyedEventForWindowId:(CGWindowID)windowId {
    AppInfo *appInfo = [[AppInfo alloc] initWithName:self.appDisplayName ?: self.targetBundleId
                                          identifier:self.targetBundleId
                                      identifierType:@"bundleId"
                                                 pid:self.wordPid];

    WindowInfo *windowInfo = [[WindowInfo alloc] init];
    windowInfo.windowId = [NSString stringWithFormat:@"%u", windowId];
    windowInfo.bounds = nil;

    WindowEvent *event = [[WindowEvent alloc] initWithEventType:WindowEventTypeDestroyed
                                                            app:appInfo
                                                         window:windowInfo];
    [self emitEvent:event];
}

#pragma mark - AX Window Matching

- (AXUIElementRef)findAXWindowForBounds:(CGRect)targetBounds {
    if (!self.wordAppElement) {
        return NULL;
    }

    CFTypeRef windowsRef = NULL;
    AXError error = AXUIElementCopyAttributeValue(self.wordAppElement, kAXWindowsAttribute, &windowsRef);
    if (error != kAXErrorSuccess || !windowsRef) {
        return NULL;
    }

    NSArray *axWindows = (__bridge_transfer NSArray *)windowsRef;
    AXUIElementRef matchedWindow = NULL;

    for (id windowObj in axWindows) {
        AXUIElementRef axWindow = (__bridge AXUIElementRef)windowObj;

        // Get position
        CFTypeRef positionValue = NULL;
        error = AXUIElementCopyAttributeValue(axWindow, kAXPositionAttribute, &positionValue);
        if (error != kAXErrorSuccess || !positionValue) {
            continue;
        }

        CGPoint position;
        if (!AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position)) {
            CFRelease(positionValue);
            continue;
        }
        CFRelease(positionValue);

        // Get size
        CFTypeRef sizeValue = NULL;
        error = AXUIElementCopyAttributeValue(axWindow, kAXSizeAttribute, &sizeValue);
        if (error != kAXErrorSuccess || !sizeValue) {
            continue;
        }

        CGSize size;
        if (!AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size)) {
            CFRelease(sizeValue);
            continue;
        }
        CFRelease(sizeValue);

        // Compare bounds (allow small tolerance for rounding)
        CGFloat tolerance = 2.0;
        if (fabs(position.x - targetBounds.origin.x) < tolerance &&
            fabs(position.y - targetBounds.origin.y) < tolerance &&
            fabs(size.width - targetBounds.size.width) < tolerance &&
            fabs(size.height - targetBounds.size.height) < tolerance) {
            matchedWindow = axWindow;
            CFRetain(matchedWindow);
            break;
        }
    }

    return matchedWindow;
}

- (void)getAXAttributesForWindow:(AXUIElementRef)axWindow
                    documentPath:(NSString **)outDocumentPath {
    if (!axWindow) {
        return;
    }

    // Get document path
    CFTypeRef documentRef = NULL;
    if (AXUIElementCopyAttributeValue(axWindow, kAXDocumentAttribute, &documentRef) == kAXErrorSuccess && documentRef) {
        *outDocumentPath = (__bridge_transfer NSString *)documentRef;
    }
}

- (NSString *)getRoleForWindowAtBounds:(CGRect)bounds {
    AXUIElementRef axWindow = [self findAXWindowForBounds:bounds];
    if (!axWindow) {
        return nil;
    }

    NSString *role = nil;
    CFTypeRef roleRef = NULL;
    if (AXUIElementCopyAttributeValue(axWindow, kAXRoleAttribute, &roleRef) == kAXErrorSuccess && roleRef) {
        role = (__bridge_transfer NSString *)roleRef;
    }

    CFRelease(axWindow);
    return role;
}

#pragma mark - Event Creation

- (WindowEvent *)createEventFromWindowDict:(NSDictionary *)windowDict eventType:(WindowEventType)eventType {
    AppInfo *appInfo = [[AppInfo alloc] initWithName:self.appDisplayName ?: self.targetBundleId
                                          identifier:self.targetBundleId
                                      identifierType:@"bundleId"
                                                 pid:self.wordPid];

    WindowInfo *windowInfo = [[WindowInfo alloc] init];
    CGWindowID windowId = [windowDict[(__bridge id)kCGWindowNumber] unsignedIntValue];
    windowInfo.windowId = [NSString stringWithFormat:@"%u", windowId];

    // Set window title from CGWindow name
    NSString *windowName = windowDict[(__bridge id)kCGWindowName];
    windowInfo.title = windowName;

    // Parse bounds
    CGRect bounds = CGRectZero;
    if (CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)windowDict[(__bridge id)kCGWindowBounds],
            &bounds)) {
        windowInfo.bounds = [[WindowBounds alloc] initWithRect:bounds];
    }

    // Find matching AX window and get accessibility attributes
    AXUIElementRef axWindow = [self findAXWindowForBounds:bounds];
    if (axWindow) {
        NSString *documentPath = nil;

        [self getAXAttributesForWindow:axWindow documentPath:&documentPath];

        windowInfo.documentPath = documentPath;

        CFRelease(axWindow);
    }

    return [[WindowEvent alloc] initWithEventType:eventType app:appInfo window:windowInfo];
}

#pragma mark - Event Output

- (void)emitEvent:(WindowEvent *)event {
    NSString *json = [event toJSON];
    printf("%s\n", [json UTF8String]);
    fflush(stdout);
}

@end
