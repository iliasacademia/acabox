#import "bridge.h"
#import <napi.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// Forward declaration
@class WordAccessibilityObserver;

// Import extracted window classes
#import "bridge/windows/TextPopupWindow.h"
#import "bridge/windows/ClickPopupWindow.h"
#import "bridge/windows/ButtonOverlayWindow.h"
#import "bridge/windows/LineCountButtonWindow.h"


// Global variable for popup path (declared at file scope for accessibility from both Obj-C and C++)
NSString* globalPopupPath = nil;

// Implementations

// Callback function for accessibility events
static void AccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon);

@implementation WordAccessibilityObserver {
    AXObserverRef _observer;
    AXUIElementRef _wordApp;
    pid_t _pid;
    SelectionChangedCallback _selectionCallback;
    ScrollEventCallback _scrollCallback;
    ButtonClickCallback _buttonClickCallback;
    NSTimer* _scrollDebounceTimer;
    NSTimer* _positionMonitorTimer;
    NSTimer* _windowMoveDebounceTimer;  // Debounce timer for window move/resize
    BOOL _isScrolling;
    BOOL _isWindowMoving;  // Track if window is currently moving/resizing
    CGRect _lastSelectionBounds;
    BOOL _hasLastBounds;
    CGPoint _lastPageCornerPosition;  // Track page corner position for scroll detection
    BOOL _hasLastPageCornerPosition;
    id _scrollEventMonitor;  // Global scroll event monitor
    CGRect _cachedWordBounds;  // Cached Word window bounds for performance
    NSTimeInterval _lastBoundsUpdate;  // Timestamp of last bounds cache update
    ButtonOverlayWindow* _buttonWindow;
    LineCountButtonWindow* _lineCountButton;  // NEW: Line count button
    NSString* _currentSelectedText;
    id _appActivationObserver;
    id _spaceChangeObserver;
    id _clickPopupBecameKeyObserver;
    id _clickPopupResignedKeyObserver;
    AXUIElementRef _wordWindow;  // Reference to Word's frontmost window for potential future use
    CGRect _cachedScrollAreaBounds;  // Cached scroll area bounds for when ClickPopup has focus
    NSTimeInterval _lastScrollAreaUpdate;  // Timestamp of last scroll area cache update
    int _lastBadgeCount;  // Store badge count so it can be applied when button is recreated
}

- (instancetype)initWithPID:(pid_t)pid {
    self = [super init];
    if (self) {
        _pid = pid;
        _wordApp = AXUIElementCreateApplication(pid);
        _observer = NULL;
        _isScrolling = NO;
        _isWindowMoving = NO;
        _lastSelectionBounds = CGRectZero;
        _hasLastBounds = NO;
        _lastPageCornerPosition = CGPointZero;
        _hasLastPageCornerPosition = NO;
        _scrollEventMonitor = nil;
        _cachedWordBounds = CGRectZero;
        _lastBoundsUpdate = 0;
        _clickPopupBecameKeyObserver = nil;
        _clickPopupResignedKeyObserver = nil;
        _wordWindow = NULL;
        _cachedScrollAreaBounds = CGRectZero;
        _lastScrollAreaUpdate = 0;
        _lastBadgeCount = 0;  // Initialize badge count to 0
    }
    return self;
}

- (void)dealloc {
    [self stopObserving];
    if (_wordApp) {
        CFRelease(_wordApp);
    }
    if (_wordWindow) {
        CFRelease(_wordWindow);
        _wordWindow = NULL;
    }
}

- (BOOL)checkAccessibilityPermission {
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

- (BOOL)startObserving:(SelectionChangedCallback)selectionCallback
         scrollCallback:(ScrollEventCallback)scrollCallback
      buttonClickCallback:(ButtonClickCallback)buttonClickCallback
                  error:(NSError**)error {

    if (![self checkAccessibilityPermission]) {
        if (error) {
            *error = [NSError errorWithDomain:@"WordAccessibility"
                                        code:1
                                    userInfo:@{NSLocalizedDescriptionKey: @"Accessibility permission not granted"}];
        }
        return NO;
    }

    _selectionCallback = selectionCallback;
    _scrollCallback = scrollCallback;
    _buttonClickCallback = buttonClickCallback;

    // Create observer
    AXError result = AXObserverCreate(_pid, AccessibilityCallback, &_observer);
    if (result != kAXErrorSuccess) {
        if (error) {
            *error = [NSError errorWithDomain:@"WordAccessibility"
                                        code:result
                                    userInfo:@{NSLocalizedDescriptionKey: @"Failed to create AX observer"}];
        }
        return NO;
    }

    // DISABLED: Selection-based notifications (temporarily disabled for fixed button implementation)
    // AXObserverAddNotification(_observer, _wordApp, kAXSelectedTextChangedNotification, (__bridge void*)self);
    // AXObserverAddNotification(_observer, _wordApp, kAXValueChangedNotification, (__bridge void*)self);

    // Add window position/size notifications for instant button updates
    AXObserverAddNotification(_observer, _wordApp, kAXWindowMovedNotification, (__bridge void*)self);
    AXObserverAddNotification(_observer, _wordApp, kAXWindowResizedNotification, (__bridge void*)self);

    // Add observer to run loop
    CFRunLoopAddSource(CFRunLoopGetCurrent(),
                       AXObserverGetRunLoopSource(_observer),
                       kCFRunLoopDefaultMode);

    // Listen for app activation/deactivation to show/hide button automatically
    __weak typeof(self) weakSelf = self;
    _appActivationObserver = [[NSWorkspace sharedWorkspace].notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
        pid_t ourAppPID = [[NSRunningApplication currentApplication] processIdentifier];

        NSLog(@"[Bridge] ===== APP ACTIVATION =====");
        NSLog(@"[Bridge] Active app: %@ (PID: %d)", app.localizedName, app.processIdentifier);
        NSLog(@"[Bridge] Word PID: %d, Our app PID: %d", strongSelf->_pid, ourAppPID);

        // If our Academia app (which owns the ClickPopup) became active, skip handling
        // The window-level notifications will handle ClickPopup focus changes
        if (app.processIdentifier == ourAppPID) {
            NSLog(@"[Bridge] Our app activated - skipping (window notifications will handle)");
            NSLog(@"[Bridge] =====================================");
            return;
        }

        if (app.processIdentifier == strongSelf->_pid) {
            // MS Word came to foreground - show button
            NSLog(@"[Bridge] Word activated - showing Count button");
            [strongSelf startWordWindowTracking];

            // Restore click popup if it was visible before Word lost focus
            if (strongSelf->_lineCountButton &&
                strongSelf->_lineCountButton.clickPopup &&
                strongSelf->_lineCountButton.clickPopup.wasVisibleBeforeHiding) {
                NSLog(@"[Bridge] Restoring ClickPopup that was visible before");
                [strongSelf->_lineCountButton showClickPopup];
                strongSelf->_lineCountButton.clickPopup.wasVisibleBeforeHiding = NO;
            }
        } else {
            // Different app activated (not Word, not our app)
            NSLog(@"[Bridge] Different app activated - hiding button and ClickPopup");

            // Check if ClickPopup is currently visible so we can restore it later
            if (strongSelf->_lineCountButton && strongSelf->_lineCountButton.clickPopup) {
                BOOL isClickPopupVisible = [strongSelf->_lineCountButton.clickPopup isVisible];
                if (isClickPopupVisible) {
                    // Remember that ClickPopup was visible so we can restore it
                    strongSelf->_lineCountButton.clickPopup.wasVisibleBeforeHiding = YES;
                    NSLog(@"[Bridge] ClickPopup was visible - will restore when returning to Word");
                }
            }

            // Hide both button and ClickPopup when switching to different app
            [strongSelf hideButtonAndPopup:YES];

            // Stop position monitoring to save resources
            if (strongSelf->_positionMonitorTimer) {
                [strongSelf->_positionMonitorTimer invalidate];
                strongSelf->_positionMonitorTimer = nil;
            }
        }
        NSLog(@"[Bridge] =====================================");
    }];

    // Listen for space/desktop changes to hide overlays immediately
    // This handles Mission Control and manual space switching
    _spaceChangeObserver = [[NSWorkspace sharedWorkspace].notificationCenter
        addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        // Hide overlays immediately when switching spaces
        [strongSelf handleSpaceChange];
    }];

    // Check if Word is currently the active application and show button immediately
    NSRunningApplication *activeApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (activeApp.processIdentifier == _pid) {
        [self startWordWindowTracking];
    }

    return YES;
}

- (void)stopObserving {
    // Stop all timers first (must be on main thread)
    dispatch_sync(dispatch_get_main_queue(), ^{
        if (self->_scrollDebounceTimer) {
            [self->_scrollDebounceTimer invalidate];
            self->_scrollDebounceTimer = nil;
        }

        if (self->_positionMonitorTimer) {
            [self->_positionMonitorTimer invalidate];
            self->_positionMonitorTimer = nil;
        }

        if (self->_windowMoveDebounceTimer) {
            [self->_windowMoveDebounceTimer invalidate];
            self->_windowMoveDebounceTimer = nil;
        }

        // Stop scroll event monitor
        [self stopScrollEventMonitor];

        // Hide and destroy button window synchronously
        if (self->_buttonWindow) {
            [self->_buttonWindow destroyPopup];  // Properly destroy the popup window
            [self->_buttonWindow orderOut:nil];
            [self->_buttonWindow close];
            self->_buttonWindow = nil;
        }

        // Hide and destroy line count button synchronously
        if (self->_lineCountButton) {
            [self->_lineCountButton hideHoverPopup];
            [self->_lineCountButton hideClickPopup];
            [self->_lineCountButton orderOut:nil];
            [self->_lineCountButton close];
            self->_lineCountButton = nil;
        }
    });

    // Remove app activation observer
    if (_appActivationObserver) {
        [[NSWorkspace sharedWorkspace].notificationCenter removeObserver:_appActivationObserver];
        _appActivationObserver = nil;
    }

    // Remove space change observer
    if (_spaceChangeObserver) {
        [[NSWorkspace sharedWorkspace].notificationCenter removeObserver:_spaceChangeObserver];
        _spaceChangeObserver = nil;
    }

    // Remove ClickPopup window observers
    [self unregisterClickPopupObservers];

    // Stop accessibility observer
    if (_observer) {
        // DISABLED: Selection-based notifications (temporarily disabled)
        // AXObserverRemoveNotification(_observer, _wordApp, kAXSelectedTextChangedNotification);
        // AXObserverRemoveNotification(_observer, _wordApp, kAXValueChangedNotification);

        // Remove window move/resize notifications
        AXObserverRemoveNotification(_observer, _wordApp, kAXWindowMovedNotification);
        AXObserverRemoveNotification(_observer, _wordApp, kAXWindowResizedNotification);

        CFRunLoopRemoveSource(CFRunLoopGetCurrent(),
                             AXObserverGetRunLoopSource(_observer),
                             kCFRunLoopDefaultMode);
        CFRelease(_observer);
        _observer = NULL;
    }

    // Clear state
    _hasLastBounds = NO;
    _isScrolling = NO;
    _isWindowMoving = NO;
    _currentSelectedText = nil;
}

- (void)showButtonAtPosition:(CGRect)bounds withText:(NSString*)text {
    dispatch_async(dispatch_get_main_queue(), ^{
        // Store current selection
        self->_currentSelectedText = text;

        // Create button window if it doesn't exist
        if (!self->_buttonWindow) {
            NSLog(@"[Bridge-Observer] Creating new ButtonOverlayWindow");
            self->_buttonWindow = [[ButtonOverlayWindow alloc] initWithObserver:self];

            // Apply stored badge count to newly created window
            if (self->_lastBadgeCount > 0) {
                NSLog(@"[Bridge-Observer] Applying stored badge count %d to new button window", self->_lastBadgeCount);
                [self->_buttonWindow updateBadge:self->_lastBadgeCount];
            }
        }

        // Update the selected text for hover popup
        [self->_buttonWindow setSelectedText:text];

        // Store selection bounds for popup positioning
        self->_buttonWindow.selectionBounds = bounds;

        // Get the document's left margin
        CGFloat leftMargin = [self getDocumentLeftMargin];

        // Position button to the left of the document margin
        CGFloat buttonWidth = 10;  // Current button width
        CGFloat buttonPadding = 15;  // Space between button and margin
        CGFloat buttonX;

        if (leftMargin > 0) {
            // Use document left margin
            buttonX = leftMargin + buttonPadding;
        } else {
            // Fallback: position to left of selection
            buttonX = bounds.origin.x - buttonWidth - buttonPadding;
        }

        CGPoint buttonPosition = CGPointMake(buttonX, bounds.origin.y);
        [self->_buttonWindow positionAtPoint:buttonPosition withHeight:bounds.size.height];

        // Show the button without activating (non-activating panel)
        [self->_buttonWindow orderFrontRegardless];
    });
}

- (void)hideButton {
    // Convenience method - hide button but keep ClickPopup visible (for scroll)
    [self hideButtonAndPopup:NO];
}

- (void)hideButtonAndPopup:(BOOL)hideClickPopup {
    // Execute synchronously for immediate hiding (called from main thread via NSEvent handler)
    if (_buttonWindow) {
        [_buttonWindow orderOut:nil];
    }
    if (_lineCountButton) {
        [_lineCountButton hideHoverPopup];

        if (hideClickPopup) {
            // Hide ClickPopup (e.g., when switching apps)
            [_lineCountButton hideClickPopup];
        }
        // Otherwise keep ClickPopup visible (e.g., during scroll)

        [_lineCountButton orderOut:nil];
    }
}

- (void)showFixedButton {
    dispatch_async(dispatch_get_main_queue(), ^{
        // Create button window if it doesn't exist
        if (!self->_buttonWindow) {
            NSLog(@"[Bridge-Observer] Creating new ButtonOverlayWindow in showFixedButton");
            self->_buttonWindow = [[ButtonOverlayWindow alloc] initWithObserver:self];

            // Apply stored badge count to newly created window
            if (self->_lastBadgeCount > 0) {
                NSLog(@"[Bridge-Observer] Applying stored badge count %d to new button window", self->_lastBadgeCount);
                [self->_buttonWindow updateBadge:self->_lastBadgeCount];
            }
        }

        // Get Word window bounds
        CGRect wordBounds = [self getWordWindowBounds];
        if (CGRectIsEmpty(wordBounds)) {
            return;
        }

        // Position to the right of Grammarly button
        // Grammarly button is typically ~40-50px from left edge and ~40px wide
        CGFloat bottomPadding = 40.0;  // Match Grammarly's vertical position
        CGFloat leftOffset = 45.0;  // Position to the right of Grammarly button
        CGFloat buttonSize = 24.0;

        // Get primary screen height for coordinate conversion
        NSScreen* primaryScreen = [NSScreen screens][0];
        CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

        // Word bounds are in top-left coordinate system (from Accessibility API)
        // Convert to Cocoa coordinates (bottom-left origin)
        CGFloat windowBottom = primaryScreenHeight - (wordBounds.origin.y + wordBounds.size.height);

        // Position button to the right of Grammarly button at bottom
        CGFloat buttonX = wordBounds.origin.x + leftOffset;
        CGFloat buttonY = windowBottom + bottomPadding;

        // Position the button window
        // Window must accommodate badge (badge extends 6px beyond button's right AND top edges)
        CGFloat badgeOverhang = 6.0;
        NSRect buttonFrame = NSMakeRect(buttonX, buttonY, buttonSize + badgeOverhang, buttonSize + badgeOverhang);
        [self->_buttonWindow setFrame:buttonFrame display:YES];

        // Show the button without activating (non-activating panel)
        [self->_buttonWindow orderFrontRegardless];

        // Also show line count button
        [self showLineCountButton];
    });
}

- (void)showLineCountButton {
    // Must be called from main queue
    dispatch_async(dispatch_get_main_queue(), ^{
        // Create line count button if it doesn't exist
        if (!self->_lineCountButton) {
            self->_lineCountButton = [[LineCountButtonWindow alloc] initWithObserver:self];
        }

        // Get Word window bounds and text area info
        CGRect wordBounds = [self getWordWindowBounds];
        if (CGRectIsEmpty(wordBounds)) {
            NSLog(@"[LineCountButton] Cannot show - Word window bounds unavailable");
            return;
        }

        // Get the position of the page corner (top-left of document including margins)
        CGPoint pageCorner = [self getDocumentTopLeftCorner];

        CGFloat buttonSize = 24.0;
        CGFloat buttonX, buttonY;

        if (!CGPointEqualToPoint(pageCorner, CGPointZero)) {
            // Successfully got page corner position - position button at the left edge of page
            CGFloat leftMargin = 12.0;   // 12px margin from left edge of page
            CGFloat topOffset = 12.0;   // 12px offset from top of page corner
            buttonX = pageCorner.x + leftMargin;

            // Convert from top-left origin (Accessibility API) to bottom-left origin (Cocoa)
            NSScreen* primaryScreen = [NSScreen screens][0];
            CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

            // Convert Y coordinate: bottom-left Y = screenHeight - topLeft Y
            // Add topOffset to position button slightly below the page corner
            CGFloat cocoaY = primaryScreenHeight - pageCorner.y - topOffset - buttonSize;

            buttonY = cocoaY;
        } else {
            // Fallback to fixed positioning if we can't get page corner
            CGFloat topPadding = 150.0;
            CGFloat leftPadding = 50.0;

            // Get primary screen height for coordinate conversion
            NSScreen* primaryScreen = [NSScreen screens][0];
            CGFloat primaryScreenHeight = primaryScreen.frame.size.height;
            CGFloat windowTop = primaryScreenHeight - wordBounds.origin.y;

            buttonX = wordBounds.origin.x + leftPadding;
            buttonY = windowTop - topPadding;
        }

        // Get scroll area bounds to check if button is within scrollable content
        // Check if ClickPopup currently has focus
        BOOL clickPopupHasFocus = (self->_lineCountButton &&
                                   self->_lineCountButton.clickPopup &&
                                   [self->_lineCountButton.clickPopup isKeyWindow]);

        CGRect scrollAreaBounds;
        if (clickPopupHasFocus && !CGRectIsEmpty(self->_cachedScrollAreaBounds)) {
            // Use cached bounds when ClickPopup has focus (Word doesn't have focus to query)
            scrollAreaBounds = self->_cachedScrollAreaBounds;
        } else {
            // Query fresh bounds from Word
            scrollAreaBounds = [self getScrollAreaBounds];
            if (!CGRectIsEmpty(scrollAreaBounds)) {
                // Update cache with fresh bounds
                self->_cachedScrollAreaBounds = scrollAreaBounds;
                self->_lastScrollAreaUpdate = [[NSDate date] timeIntervalSince1970];
            }
        }

        if (CGRectIsEmpty(scrollAreaBounds)) {
            // No scroll area found - hide button
            NSLog(@"[LineCountButton] Hiding button - no scroll area bounds available");
            [self->_lineCountButton orderOut:nil];
            return;
        }

        // Validate that button position is on-screen
        NSRect buttonFrame = NSMakeRect(buttonX, buttonY, buttonSize, buttonSize);

        // Check for intersection between button and scroll area bounds
        // Convert scroll area bounds from Accessibility coordinates (top-left origin) to Cocoa coordinates (bottom-left origin)
        NSScreen* primaryScreen = [NSScreen screens][0];
        CGFloat primaryScreenHeight = primaryScreen.frame.size.height;

        CGRect scrollAreaCocoa = CGRectMake(
            scrollAreaBounds.origin.x,
            primaryScreenHeight - scrollAreaBounds.origin.y - scrollAreaBounds.size.height,
            scrollAreaBounds.size.width,
            scrollAreaBounds.size.height
        );

        // Calculate intersection between button frame and scroll area
        NSRect visibleRect = NSIntersectionRect(scrollAreaCocoa, buttonFrame);

        if (NSIsEmptyRect(visibleRect)) {
            // No intersection - button is completely outside scroll area, hide it
            NSLog(@"[LineCountButton] Hiding button - completely outside scroll area bounds");
            [self->_lineCountButton orderOut:nil];
            return;
        }

        // Check if button is within any visible screen bounds
        BOOL isOnScreen = NO;
        for (NSScreen* screen in [NSScreen screens]) {
            if (NSIntersectsRect(buttonFrame, screen.frame)) {
                isOnScreen = YES;
                break;
            }
        }

        if (!isOnScreen) {
            // Button would be off-screen, hide it instead
            [self->_lineCountButton orderOut:nil];
            return;
        }

        // Position the button window
        [self->_lineCountButton setFrame:buttonFrame display:YES];

        // Apply clipping mask if button is partially outside scroll area
        if (NSContainsRect(scrollAreaCocoa, buttonFrame)) {
            // Button is fully contained - clear any existing mask
            [self->_lineCountButton clearVisibleRectMask];
        } else {
            // Button is partially visible - apply clipping mask
            [self->_lineCountButton setVisibleRect:visibleRect inFrame:buttonFrame];
            NSLog(@"[LineCountButton] Button partially visible - clipping mask applied");
        }

        // Show the button without activating (non-activating panel)
        [self->_lineCountButton orderFrontRegardless];
    });
}

- (void)startWordWindowTracking {
    // Start scroll event monitor for immediate scroll detection
    [self startScrollEventMonitor];

    // Start position monitoring timer for fallback (keyboard scrolling, edge cases)
    [_positionMonitorTimer invalidate];
    _positionMonitorTimer = [NSTimer scheduledTimerWithTimeInterval:0.5  // Check every 500ms (fallback for edge cases)
                                                             repeats:YES
                                                               block:^(NSTimer * _Nonnull timer) {
        [self updateButtonPosition];
    }];

    // Show button immediately
    [self showFixedButton];
}

- (void)updateCachedWordBounds {
    _cachedWordBounds = [self getWordWindowBounds];
    _lastBoundsUpdate = [[NSDate date] timeIntervalSince1970];
}

- (void)startScrollEventMonitor {
    if (_scrollEventMonitor) {
        return;  // Already monitoring
    }

    // Initialize bounds cache
    [self updateCachedWordBounds];

    __weak WordAccessibilityObserver* weakSelf = self;

    _scrollEventMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                                                  handler:^(NSEvent *event) {
        WordAccessibilityObserver* strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }

        // Get mouse location in screen coordinates
        NSPoint mouseLocation = [NSEvent mouseLocation];

        // Refresh bounds cache if stale (older than 1 second)
        NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
        if (now - strongSelf->_lastBoundsUpdate > 1.0 || CGRectIsEmpty(strongSelf->_cachedWordBounds)) {
            [strongSelf updateCachedWordBounds];
        }

        // Check if mouse is within Word window bounds
        if (!CGRectIsEmpty(strongSelf->_cachedWordBounds) &&
            NSPointInRect(mouseLocation, strongSelf->_cachedWordBounds)) {
            // Mouse is over Word window - handle scroll event
            [strongSelf handleScrollEvent:event];
        }
    }];
}

- (void)handleScrollEvent:(NSEvent*)event {
    // Ignore momentum scrolling (only handle active user scrolling)
    if (event.momentumPhase != NSEventPhaseNone) {
        // During momentum phase, still debounce but don't trigger initial hide
        if (_isScrolling) {
            // Reset debounce timer during momentum
            [_scrollDebounceTimer invalidate];
            _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                                    repeats:NO
                                                                      block:^(NSTimer * _Nonnull timer) {
                self->_isScrolling = NO;
                [self showFixedButton];
            }];
        }
        return;
    }

    // Active scrolling detected
    if (!_isScrolling) {
        _isScrolling = YES;
        // Hide button and popup immediately
        [self hideButton];

        // Invalidate cached scroll area bounds (document scrolled)
        _cachedScrollAreaBounds = CGRectZero;
        _lastScrollAreaUpdate = 0;
    }

    // Debounce scroll end - reset timer on each scroll event
    [_scrollDebounceTimer invalidate];
    _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                            repeats:NO
                                                              block:^(NSTimer * _Nonnull timer) {
        self->_isScrolling = NO;
        // Show button at new position after scroll ends
        [self showFixedButton];
    }];
}

- (void)stopScrollEventMonitor {
    if (_scrollEventMonitor) {
        [NSEvent removeMonitor:_scrollEventMonitor];
        _scrollEventMonitor = nil;
    }
}

- (void)updateButtonPosition {
    if (!_buttonWindow) {
        return;
    }

    // Get current Word window bounds
    CGRect wordBounds = [self getWordWindowBounds];
    if (CGRectIsEmpty(wordBounds)) {
        // Word window not available, hide button
        [self hideButton];
        return;
    }

    // Get current page corner position for scroll detection
    CGPoint currentPageCornerPosition = [self getDocumentTopLeftCorner];

    // Check if page corner position changed (indicates scrolling)
    if (_hasLastPageCornerPosition && !CGPointEqualToPoint(currentPageCornerPosition, CGPointZero)) {
        CGFloat tolerance = 1.0;  // 1px tolerance
        BOOL positionChanged = (fabs(currentPageCornerPosition.y - _lastPageCornerPosition.y) > tolerance);

        if (positionChanged) {
            // Position changed - user is scrolling
            if (!_isScrolling) {
                _isScrolling = YES;
                // Hide button and popup immediately on scroll start
                [self hideButton];
            }

            // Update stored position
            _lastPageCornerPosition = currentPageCornerPosition;

            // Debounce scroll end
            [_scrollDebounceTimer invalidate];
            _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                                    repeats:NO
                                                                      block:^(NSTimer * _Nonnull timer) {
                self->_isScrolling = NO;
                // Show button at new position after scroll ends
                [self showFixedButton];
            }];

            return;  // Don't update button position while scrolling
        }
    }

    // Store current position for next check
    if (!CGPointEqualToPoint(currentPageCornerPosition, CGPointZero)) {
        _lastPageCornerPosition = currentPageCornerPosition;
        _hasLastPageCornerPosition = YES;
    }

    // Update button position (only if not scrolling)
    if (!_isScrolling) {
        [self showFixedButton];
    }
}

- (void)handleWindowMoveOrResize {
    // Immediately hide button during window movement/resize
    if (!_isWindowMoving) {
        _isWindowMoving = YES;
        [self hideButton];
    }

    // Update cached Word bounds immediately when window moves
    [self updateCachedWordBounds];

    // Invalidate cached scroll area bounds (window moved/resized)
    _cachedScrollAreaBounds = CGRectZero;
    _lastScrollAreaUpdate = 0;

    // Cancel any existing debounce timer
    if (_windowMoveDebounceTimer) {
        [_windowMoveDebounceTimer invalidate];
        _windowMoveDebounceTimer = nil;
    }

    // Start new debounce timer (500ms)
    __weak typeof(self) weakSelf = self;
    _windowMoveDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf) {
            // Window movement stopped for 500ms - show button at new position
            strongSelf->_isWindowMoving = NO;
            [strongSelf updateButtonPosition];
            strongSelf->_windowMoveDebounceTimer = nil;
        }
    }];
}

- (void)handleSpaceChange {
    // Hide overlays immediately when space/desktop changes
    [self hideButton];

    // Stop position monitoring to save resources
    if (_positionMonitorTimer) {
        [_positionMonitorTimer invalidate];
        _positionMonitorTimer = nil;
    }

    // WAGENT-77: Removed 200ms arbitrary delay
    // The existing NSWorkspaceDidActivateApplicationNotification listener (line 140)
    // will automatically handle showing overlays when Word becomes active on the new space.
    // This eliminates the timing hack and makes the behavior more reliable.
}

// Observer registration for ClickPopup window
- (void)registerClickPopupObservers {
    if (!_lineCountButton || !_lineCountButton.clickPopup) {
        NSLog(@"[Bridge] Cannot register ClickPopup observers - popup doesn't exist");
        return;
    }

    // Remove existing observers first (in case of re-registration)
    [self unregisterClickPopupObservers];

    NSLog(@"[Bridge] Registering window notification observers for ClickPopup");

    __weak typeof(self) weakSelf = self;

    // Register for ClickPopup becoming key window
    _clickPopupBecameKeyObserver = [[NSNotificationCenter defaultCenter]
        addObserverForName:NSWindowDidBecomeKeyNotification
                    object:_lineCountButton.clickPopup
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf) {
            [strongSelf clickPopupDidBecomeKey:notification];
        }
    }];

    // Register for ClickPopup resigning key window
    _clickPopupResignedKeyObserver = [[NSNotificationCenter defaultCenter]
        addObserverForName:NSWindowDidResignKeyNotification
                    object:_lineCountButton.clickPopup
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf) {
            [strongSelf clickPopupDidResignKey:notification];
        }
    }];

    NSLog(@"[Bridge] ClickPopup observers registered successfully");
}

- (void)unregisterClickPopupObservers {
    if (_clickPopupBecameKeyObserver) {
        [[NSNotificationCenter defaultCenter] removeObserver:_clickPopupBecameKeyObserver];
        _clickPopupBecameKeyObserver = nil;
        NSLog(@"[Bridge] Removed ClickPopup becameKey observer");
    }

    if (_clickPopupResignedKeyObserver) {
        [[NSNotificationCenter defaultCenter] removeObserver:_clickPopupResignedKeyObserver];
        _clickPopupResignedKeyObserver = nil;
        NSLog(@"[Bridge] Removed ClickPopup resignedKey observer");
    }
}

// Window-level focus notification handlers
- (void)clickPopupDidBecomeKey:(NSNotification *)notification {
    NSLog(@"[Bridge] ===== ClickPopup Became Key =====");
    NSLog(@"[Bridge] ClickPopupWindow gained focus - ensuring Count button stays visible");

    // Make sure Count button is still showing when ClickPopup becomes key
    // This handles the case where user clicks in the popup to enter text
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_lineCountButton) {
            // Ensure button is visible
            [self showLineCountButton];
            NSLog(@"[Bridge] Count button kept visible while ClickPopup is key");
        }
    });
}

- (void)clickPopupDidResignKey:(NSNotification *)notification {
    NSLog(@"[Bridge] ===== ClickPopup Resigned Key =====");
    NSLog(@"[Bridge] ClickPopupWindow lost focus - checking where focus went");

    dispatch_async(dispatch_get_main_queue(), ^{
        // Check if focus went back to Word (Word became active)
        NSRunningApplication *activeApp = [[NSWorkspace sharedWorkspace] frontmostApplication];

        if (activeApp.processIdentifier == self->_pid) {
            // Focus returned to Word - keep button visible
            NSLog(@"[Bridge] Focus returned to Word - keeping Count button visible");
            [self showLineCountButton];
        } else {
            // Focus went to a different app - hide button and ClickPopup
            NSLog(@"[Bridge] Focus went to different app: %@ - hiding button and ClickPopup", activeApp.localizedName);

            // Remember if ClickPopup was visible so we can restore it
            if (self->_lineCountButton && self->_lineCountButton.clickPopup) {
                BOOL isVisible = [self->_lineCountButton.clickPopup isVisible];
                if (isVisible) {
                    self->_lineCountButton.clickPopup.wasVisibleBeforeHiding = YES;
                }
            }

            // Hide both button and ClickPopup
            [self hideButtonAndPopup:YES];
        }
    });
}

- (void)handleAppActivation {
    // When MS Word comes to foreground, delay slightly to allow the text editor to receive focus
    // before querying the accessibility API for selected text
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.15 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        NSDictionary* selection = [strongSelf getSelectedText];
        if (selection && [selection[@"text"] length] > 0) {
            NSString* text = selection[@"text"];
            CGRect bounds = CGRectMake(
                [selection[@"x"] doubleValue],
                [selection[@"y"] doubleValue],
                [selection[@"width"] doubleValue],
                [selection[@"height"] doubleValue]
            );

            // Update stored bounds
            strongSelf->_lastSelectionBounds = bounds;
            strongSelf->_hasLastBounds = YES;

            // Show the button at the current position
            [strongSelf showButtonAtPosition:bounds withText:text];

            // Always restart position monitoring to ensure it's running
            [strongSelf->_positionMonitorTimer invalidate];
            strongSelf->_positionMonitorTimer = [NSTimer scheduledTimerWithTimeInterval:0.05
                                                                                 repeats:YES
                                                                                   block:^(NSTimer * _Nonnull timer) {
                [strongSelf checkPositionChange];
            }];
        }
    });
}

- (void)handleButtonClick {
    // Also send callback to JavaScript for logging in main.ts
    if (_buttonClickCallback) {
        _buttonClickCallback("academia-button-clicked");
    }
}

- (void)handleButtonClickWithAction:(NSString*)action text:(NSString*)text {
    // Call back to JavaScript with action and text
    if (_buttonClickCallback && text && action) {
        // Format: "action|text" so JavaScript can parse it
        NSString* message = [NSString stringWithFormat:@"%@|%@", action, text];
        _buttonClickCallback([message UTF8String]);
    }
}

- (NSDictionary*)getSelectedText {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return nil;
    }

    // Get selected text
    CFTypeRef selectedText = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXSelectedTextAttribute, &selectedText);

    if (error != kAXErrorSuccess || !selectedText) {
        CFRelease(focusedElement);
        return nil;
    }

    NSString* text = (__bridge_transfer NSString*)selectedText;

    // Get selected text range
    CFTypeRef selectedRange = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXSelectedTextRangeAttribute, &selectedRange);

    CGRect bounds = CGRectZero;
    if (error == kAXErrorSuccess && selectedRange) {
        // Get bounds for the selected range
        CFTypeRef rangeValue = NULL;
        error = AXUIElementCopyParameterizedAttributeValue(focusedElement,
                                                           kAXBoundsForRangeParameterizedAttribute,
                                                           selectedRange,
                                                           &rangeValue);
        if (error == kAXErrorSuccess && rangeValue) {
            AXValueGetValue((AXValueRef)rangeValue, (AXValueType)kAXValueTypeCGRect, &bounds);
            CFRelease(rangeValue);
        }
        CFRelease(selectedRange);
    }

    CFRelease(focusedElement);

    return @{
        @"text": text ?: @"",
        @"x": @(bounds.origin.x),
        @"y": @(bounds.origin.y),
        @"width": @(bounds.size.width),
        @"height": @(bounds.size.height)
    };
}

- (NSDictionary*)getFirstTextAreaInfo {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return nil;
    }

    // Verify this is a text area
    CFTypeRef roleValue = NULL;
    AXUIElementCopyAttributeValue(focusedElement, kAXRoleAttribute, &roleValue);
    NSString* role = (__bridge_transfer NSString*)roleValue;

    if (![role isEqualToString:@"AXTextArea"]) {
        CFRelease(focusedElement);
        return nil;
    }

    // Get the full text content using AXValue
    CFTypeRef textValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, CFSTR("AXValue"), &textValue);

    NSString* text = @"";
    if (error == kAXErrorSuccess && textValue) {
        text = (__bridge_transfer NSString*)textValue;
    }

    // Get number of characters
    CFTypeRef charCountValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, CFSTR("AXNumberOfCharacters"), &charCountValue);

    NSInteger charCount = 0;
    if (error == kAXErrorSuccess && charCountValue) {
        CFNumberGetValue((CFNumberRef)charCountValue, kCFNumberNSIntegerType, &charCount);
        CFRelease(charCountValue);
    }

    // Get position
    CFTypeRef positionValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXPositionAttribute, &positionValue);
    CGPoint position = CGPointZero;
    if (error == kAXErrorSuccess && positionValue) {
        AXValueGetValue((AXValueRef)positionValue, kAXValueTypeCGPoint, &position);
        CFRelease(positionValue);
    }

    // Get size
    CFTypeRef sizeValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, kAXSizeAttribute, &sizeValue);
    CGSize size = CGSizeZero;
    if (error == kAXErrorSuccess && sizeValue) {
        AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size);
        CFRelease(sizeValue);
    }

    CFRelease(focusedElement);

    return @{
        @"text": text ?: @"",
        @"x": @(position.x),
        @"y": @(position.y),
        @"width": @(size.width),
        @"height": @(size.height),
        @"charCount": @(charCount)
    };
}

- (pid_t)getWordPID {
    return _pid;
}

- (AXUIElementRef)getWordApp {
    return _wordApp;
}

- (BOOL)focusDocument {
    NSLog(@"[Bridge] ===== focusDocument START =====");

    // Get the frontmost window of Word
    CFTypeRef windowsRef = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXWindowsAttribute, &windowsRef);

    if (error != kAXErrorSuccess || !windowsRef) {
        NSLog(@"[Bridge] ERROR: Could not get Word windows (error: %d)", error);
        return NO;
    }

    CFArrayRef windows = (CFArrayRef)windowsRef;
    if (CFArrayGetCount(windows) == 0) {
        NSLog(@"[Bridge] ERROR: No Word windows found");
        CFRelease(windowsRef);
        return NO;
    }

    // Get the first window (frontmost)
    AXUIElementRef frontWindow = (AXUIElementRef)CFArrayGetValueAtIndex(windows, 0);

    // DEFENSIVE CHECK 1: Validate frontWindow is not NULL
    if (!frontWindow) {
        NSLog(@"[Bridge] ERROR: frontWindow is NULL");
        CFRelease(windowsRef);
        return NO;
    }

    // Retain frontWindow since it's a borrowed reference we're storing
    CFRetain(frontWindow);

    NSLog(@"[Bridge] Got frontmost Word window");

    // Use iterative approach with a queue to avoid block retain cycle
    AXUIElementRef textAreaElement = NULL;
    NSMutableArray* queue = [NSMutableArray arrayWithObject:(__bridge id)frontWindow];
    NSMutableArray* depths = [NSMutableArray arrayWithObject:@0];

    // DEFENSIVE CHECK 2: Add iteration limit to prevent infinite loops
    int maxIterations = 1000;
    int iterations = 0;

    while (queue.count > 0 && depths.count > 0 && !textAreaElement && iterations < maxIterations) {
        iterations++;

        // DEFENSIVE CHECK 3: Validate queue/depths sync
        if (queue.count != depths.count) {
            NSLog(@"[Bridge] ERROR: Queue and depths out of sync (%lu vs %lu)",
                  (unsigned long)queue.count, (unsigned long)depths.count);
            break;
        }

        AXUIElementRef element = (__bridge AXUIElementRef)[queue firstObject];
        int depth = [[depths firstObject] intValue];
        [queue removeObjectAtIndex:0];
        [depths removeObjectAtIndex:0];

        // DEFENSIVE CHECK 4: Validate element is not NULL
        if (!element) {
            NSLog(@"[Bridge] WARNING: NULL element in queue at depth %d, skipping", depth);
            continue;
        }

        if (depth > 10) continue; // Limit depth

        // Get role
        CFTypeRef roleValue = NULL;
        AXError roleError = AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &roleValue);

        // DEFENSIVE CHECK 5: Handle invalid element errors
        if (roleError == kAXErrorInvalidUIElement) {
            NSLog(@"[Bridge] WARNING: Invalid/stale element at depth %d, skipping", depth);
            continue;
        }

        if (roleError == kAXErrorSuccess && roleValue) {
            NSString* role = (__bridge_transfer NSString*)roleValue;

            if ([role isEqualToString:@"AXTextArea"]) {
                NSLog(@"[Bridge] Found AXTextArea at depth %d", depth);
                textAreaElement = element;
                CFRetain(textAreaElement);
                break;
            }
        } else if (roleError != kAXErrorSuccess) {
            NSLog(@"[Bridge] WARNING: Failed to get role at depth %d (error: %d)", depth, roleError);
        }

        // Get children and add to queue
        CFTypeRef childrenRef = NULL;
        AXError childrenError = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenRef);

        // DEFENSIVE CHECK 6: Handle invalid element during children retrieval
        if (childrenError == kAXErrorInvalidUIElement) {
            NSLog(@"[Bridge] WARNING: Element became invalid while getting children at depth %d", depth);
            continue;
        }

        if (childrenError == kAXErrorSuccess && childrenRef) {
            CFArrayRef children = (CFArrayRef)childrenRef;
            CFIndex childCount = CFArrayGetCount(children);

            for (CFIndex i = 0; i < childCount; i++) {
                AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i);

                // DEFENSIVE CHECK 7: Validate child is not NULL
                if (!child) {
                    NSLog(@"[Bridge] WARNING: NULL child at index %ld (depth %d), skipping", i, depth);
                    continue;
                }

                // Retain child since it's a borrowed reference we're storing
                CFRetain(child);

                [queue addObject:(__bridge id)child];
                [depths addObject:@(depth + 1)];
            }

            CFRelease(childrenRef);
        } else if (childrenError != kAXErrorSuccess) {
            NSLog(@"[Bridge] WARNING: Failed to get children at depth %d (error: %d)", depth, childrenError);
        }

        // Release element when done processing it
        CFRelease(element);
    }

    // Clean up any remaining elements in queue that weren't processed
    for (id obj in queue) {
        AXUIElementRef element = (__bridge AXUIElementRef)obj;
        if (element) {
            CFRelease(element);
        }
    }

    // DEFENSIVE CHECK 8: Log if iteration limit reached
    if (iterations >= maxIterations) {
        NSLog(@"[Bridge] ERROR: Traversal exceeded max iterations (%d)", maxIterations);
        CFRelease(windowsRef);
        return NO;
    }

    // Keep windowsRef alive during traversal - release after we're done using elements

    if (!textAreaElement) {
        NSLog(@"[Bridge] ERROR: Could not find AXTextArea in window hierarchy");
        CFRelease(windowsRef);
        return NO;
    }

    NSLog(@"[Bridge] Attempting to set focus on AXTextArea...");

    // Try to set focus on the text area
    error = AXUIElementSetAttributeValue(textAreaElement, kAXFocusedAttribute, kCFBooleanTrue);

    CFRelease(textAreaElement);

    if (error != kAXErrorSuccess) {
        NSLog(@"[Bridge] ERROR: Could not set focus (error: %d)", error);
        CFRelease(windowsRef);
        return NO;
    }

    NSLog(@"[Bridge] Successfully set focus on document");
    CFRelease(windowsRef);
    return YES;
}

- (NSDictionary*)findTextPosition:(NSString*)searchText {
    NSLog(@"[Bridge] ===== findTextPosition START =====");
    NSLog(@"[Bridge] Searching for: \"%@\"", searchText);

    if (!searchText || searchText.length == 0) {
        NSLog(@"[Bridge] ERROR: Empty search text");
        return @{@"found": @NO};
    }

    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        NSLog(@"[Bridge] ERROR: Could not get focused element (error: %d)", error);
        return @{@"found": @NO};
    }
    NSLog(@"[Bridge] Got focused element successfully");

    // Verify this is a text area
    CFTypeRef roleValue = NULL;
    AXUIElementCopyAttributeValue(focusedElement, kAXRoleAttribute, &roleValue);
    NSString* role = (__bridge_transfer NSString*)roleValue;
    NSLog(@"[Bridge] Focused element role: %@", role);

    if (![role isEqualToString:@"AXTextArea"]) {
        NSLog(@"[Bridge] ERROR: Focused element is not AXTextArea (got %@)", role);
        CFRelease(focusedElement);
        return @{@"found": @NO};
    }

    // Get the full text content
    CFTypeRef textValue = NULL;
    error = AXUIElementCopyAttributeValue(focusedElement, CFSTR("AXValue"), &textValue);

    if (error != kAXErrorSuccess || !textValue) {
        NSLog(@"[Bridge] ERROR: Could not get AXValue (error: %d)", error);
        CFRelease(focusedElement);
        return @{@"found": @NO};
    }

    NSString* fullText = (__bridge_transfer NSString*)textValue;
    NSLog(@"[Bridge] Document text length: %lu characters", (unsigned long)[fullText length]);
    if ([fullText length] > 0) {
        NSUInteger previewLength = MIN((NSUInteger)200, [fullText length]);
        NSLog(@"[Bridge] Document text preview (first %lu chars): \"%@\"",
              (unsigned long)previewLength, [fullText substringToIndex:previewLength]);
    }

    // Search for the text (case-insensitive)
    NSLog(@"[Bridge] Performing case-insensitive search...");
    NSRange searchRange = [fullText rangeOfString:searchText options:NSCaseInsensitiveSearch];

    if (searchRange.location == NSNotFound) {
        NSLog(@"[Bridge] NOT FOUND: \"%@\" not found in document", searchText);
        CFRelease(focusedElement);
        return @{
            @"found": @NO,
            @"text": searchText
        };
    }
    NSLog(@"[Bridge] FOUND: \"%@\" at character index %lu (length %lu)",
          searchText, (unsigned long)searchRange.location, (unsigned long)searchRange.length);

    // Found! Now get the bounds for this text range
    NSLog(@"[Bridge] Getting bounds for text range...");
    CFRange range = CFRangeMake(searchRange.location, searchRange.length);
    AXValueRef rangeValue = AXValueCreate(kAXValueTypeCFRange, &range);

    CFTypeRef boundsValue = NULL;
    error = AXUIElementCopyParameterizedAttributeValue(focusedElement,
                                                       kAXBoundsForRangeParameterizedAttribute,
                                                       rangeValue,
                                                       &boundsValue);

    CGRect bounds = CGRectZero;
    if (error == kAXErrorSuccess && boundsValue) {
        AXValueGetValue((AXValueRef)boundsValue, (AXValueType)kAXValueTypeCGRect, &bounds);
        NSLog(@"[Bridge] Bounds retrieved: x=%.1f, y=%.1f, w=%.1f, h=%.1f",
              bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);
        CFRelease(boundsValue);
    } else {
        NSLog(@"[Bridge] WARNING: Could not get bounds (error: %d)", error);
    }

    CFRelease(rangeValue);
    CFRelease(focusedElement);

    NSLog(@"[Bridge] ===== findTextPosition END (SUCCESS) =====");
    return @{
        @"found": @YES,
        @"text": searchText,
        @"charIndex": @(searchRange.location),
        @"x": @(bounds.origin.x),
        @"y": @(bounds.origin.y),
        @"width": @(bounds.size.width),
        @"height": @(bounds.size.height)
    };
}

- (CGFloat)getDocumentLeftMargin {
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

    // Return the left edge (x coordinate) of the text area (the left margin)
    return position.x;
}

- (NSArray*)getParentHierarchy {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return @[];
    }

    NSMutableArray* hierarchy = [NSMutableArray array];
    AXUIElementRef currentElement = focusedElement;
    CFRetain(currentElement);

    // Walk up parent hierarchy (up to 20 levels)
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

        [hierarchy addObject:@{
            @"level": @(i),
            @"role": role ?: @"Unknown",
            @"x": @(position.x),
            @"y": @(position.y),
            @"width": @(size.width),
            @"height": @(size.height)
        }];

        // Get parent element
        CFTypeRef parentValue = NULL;
        error = AXUIElementCopyAttributeValue(currentElement, kAXParentAttribute, &parentValue);

        if (error != kAXErrorSuccess || !parentValue) {
            // No more parents - break without releasing (will be released after loop)
            break;
        }

        // We have a parent, so release current element before moving to parent
        if (currentElement != focusedElement) {
            CFRelease(currentElement);
        }

        currentElement = (AXUIElementRef)parentValue;
    }

    // Clean up final element
    if (currentElement != focusedElement) {
        CFRelease(currentElement);
    }
    CFRelease(focusedElement);

    return hierarchy;
}

- (CGPoint)getDocumentTopLeftCorner {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return CGPointZero;
    }

    // Strategy: Find AXTextArea in hierarchy, then return position 2 levels up from it
    // This gives us the page corner including top margins

    NSMutableArray* hierarchy = [NSMutableArray array];
    AXUIElementRef currentElement = focusedElement;
    CFRetain(currentElement);

    // Walk up parent hierarchy and collect all levels
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

        // Store this level
        [hierarchy addObject:@{
            @"level": @(i),
            @"role": role ?: @"Unknown",
            @"position": [NSValue valueWithPoint:NSPointFromCGPoint(position)]
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

    // Find AXTextArea in hierarchy
    int textAreaLevel = -1;
    for (NSDictionary* item in hierarchy) {
        if ([item[@"role"] isEqualToString:(__bridge NSString*)kAXTextAreaRole]) {
            textAreaLevel = [item[@"level"] intValue];
            break;
        }
    }

    // If we found AXTextArea, return position 2 levels up from it
    if (textAreaLevel >= 0) {
        NSUInteger pageLevel = (NSUInteger)(textAreaLevel + 2);
        if (pageLevel < hierarchy.count) {
            NSDictionary* pageItem = hierarchy[pageLevel];
            CGPoint pagePosition = NSPointToCGPoint([pageItem[@"position"] pointValue]);
            return pagePosition;
        }
    }

    // Fallback: AXTextArea not found (Word not focused?) - return zero
    return CGPointZero;
}

- (CGRect)getScrollAreaBounds {
    AXUIElementRef focusedElement = NULL;
    AXError error = AXUIElementCopyAttributeValue(_wordApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);

    if (error != kAXErrorSuccess || !focusedElement) {
        return CGRectZero;
    }

    // Strategy: Find AXTextArea at level 0, then check if level 4 parent is an AXScrollArea
    // If yes, return the bounds of the scroll area

    NSMutableArray* hierarchy = [NSMutableArray array];
    AXUIElementRef currentElement = focusedElement;
    CFRetain(currentElement);

    // Walk up parent hierarchy and collect all levels
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
                CGSize size = NSSizeFromCGSize([scrollItem[@"size"] sizeValue]);
                CGRect scrollBounds = CGRectMake(position.x, position.y, size.width, size.height);
                return scrollBounds;
            }
        }
    }

    // Fallback: AXScrollArea not found at expected location
    return CGRectZero;
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

    // Check if the page corner position is on-screen
    BOOL onScreen = NO;
    if (inViewport) {
        CGPoint cornerPosition = [self getDocumentTopLeftCorner];
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

    // Return true only if both conditions are met
    return inViewport && onScreen;
}

- (CGRect)getWordWindowBounds {
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

    CGRect bounds = CGRectMake(position.x, position.y, size.width, size.height);

    return bounds;
}

- (NSDictionary*)getButtonStates {
    NSMutableDictionary* states = [NSMutableDictionary dictionary];

    // Academia button state
    if (_buttonWindow) {
        NSRect frame = _buttonWindow.frame;
        states[@"academiaButton"] = @{
            @"x": @(frame.origin.x),
            @"y": @(frame.origin.y),
            @"width": @(frame.size.width),
            @"height": @(frame.size.height),
            @"isVisible": @([_buttonWindow isVisible])
        };
    } else {
        states[@"academiaButton"] = [NSNull null];
    }

    // Count button state
    if (_lineCountButton) {
        NSRect frame = _lineCountButton.frame;
        states[@"countButton"] = @{
            @"x": @(frame.origin.x),
            @"y": @(frame.origin.y),
            @"width": @(frame.size.width),
            @"height": @(frame.size.height),
            @"isVisible": @([_lineCountButton isVisible])
        };
    } else {
        states[@"countButton"] = [NSNull null];
    }

    return states;
}

- (void)checkPositionChange {
    if (!_hasLastBounds) {
        return;
    }

    NSDictionary* selection = [self getSelectedText];
    if (!selection || [selection[@"text"] length] == 0) {
        // Selection cleared, stop monitoring and hide button
        [_positionMonitorTimer invalidate];
        _positionMonitorTimer = nil;
        _hasLastBounds = NO;
        [self hideButton];
        return;
    }

    CGRect currentBounds = CGRectMake(
        [selection[@"x"] doubleValue],
        [selection[@"y"] doubleValue],
        [selection[@"width"] doubleValue],
        [selection[@"height"] doubleValue]
    );

    // Use very small tolerance for immediate detection
    CGFloat tolerance = 0.5;
    BOOL positionChanged = (fabs(currentBounds.origin.x - _lastSelectionBounds.origin.x) > tolerance ||
                           fabs(currentBounds.origin.y - _lastSelectionBounds.origin.y) > tolerance);

    if (positionChanged) {
        // Update stored bounds
        _lastSelectionBounds = currentBounds;

        if (!_isScrolling) {
            _isScrolling = YES;
            // Hide button immediately on scroll start
            [self hideButton];

            if (_scrollCallback) {
                _scrollCallback(YES);  // scrollStarted
            }
        }

        // Debounce scroll end
        [_scrollDebounceTimer invalidate];
        _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
            self->_isScrolling = NO;

            // Show button at new position after scroll ends
            NSString* text = selection[@"text"];
            [self showButtonAtPosition:currentBounds withText:text];

            if (self->_scrollCallback) {
                self->_scrollCallback(NO);  // scrollEnded
            }
        }];
    }
}

- (void)handleSelectionChanged {
    NSDictionary* selection = [self getSelectedText];
    if (selection && [selection[@"text"] length] > 0) {
        NSString* text = selection[@"text"];
        CGRect bounds = CGRectMake(
            [selection[@"x"] doubleValue],
            [selection[@"y"] doubleValue],
            [selection[@"width"] doubleValue],
            [selection[@"height"] doubleValue]
        );

        // Store the bounds for scroll detection
        _lastSelectionBounds = bounds;
        _hasLastBounds = YES;

        // Show native button immediately (no IPC delay!)
        [self showButtonAtPosition:bounds withText:text];

        // Start periodic position monitoring for immediate scroll detection
        [_positionMonitorTimer invalidate];
        _positionMonitorTimer = [NSTimer scheduledTimerWithTimeInterval:0.05  // Check every 50ms
                                                                 repeats:YES
                                                                   block:^(NSTimer * _Nonnull timer) {
            [self checkPositionChange];
        }];

        // Still notify JS about selection (for main window update)
        if (_selectionCallback) {
            _selectionCallback([text UTF8String], bounds);
        }
    }
}

- (void)handleValueChanged {
    // Detect scrolling by checking if selected text position changed
    if (!_hasLastBounds) {
        return;
    }

    NSDictionary* selection = [self getSelectedText];
    if (!selection || [selection[@"text"] length] == 0) {
        return;
    }

    CGRect currentBounds = CGRectMake(
        [selection[@"x"] doubleValue],
        [selection[@"y"] doubleValue],
        [selection[@"width"] doubleValue],
        [selection[@"height"] doubleValue]
    );

    // Check if position has changed (indicating scroll)
    // Allow small tolerance for floating point comparison
    CGFloat tolerance = 1.0;
    BOOL positionChanged = (fabs(currentBounds.origin.x - _lastSelectionBounds.origin.x) > tolerance ||
                           fabs(currentBounds.origin.y - _lastSelectionBounds.origin.y) > tolerance);

    if (positionChanged) {
        // Update stored bounds
        _lastSelectionBounds = currentBounds;

        if (!_isScrolling) {
            _isScrolling = YES;
            if (_scrollCallback) {
                _scrollCallback(YES);  // scrollStarted
            }
        }

        // Debounce scroll end
        [_scrollDebounceTimer invalidate];
        _scrollDebounceTimer = [NSTimer scheduledTimerWithTimeInterval:0.3
                                                                repeats:NO
                                                                  block:^(NSTimer * _Nonnull timer) {
            self->_isScrolling = NO;
            if (self->_scrollCallback) {
                self->_scrollCallback(NO);  // scrollEnded
            }
        }];
    }
}

- (void)updateButtonBadge:(int)count {
    NSLog(@"[Bridge-Observer] ========== updateButtonBadge called on WordAccessibilityObserver ==========");
    NSLog(@"[Bridge-Observer] count=%d, _buttonWindow=%@", count, _buttonWindow ? @"exists" : @"NULL");

    // Store the badge count so it can be applied when button is created
    _lastBadgeCount = count;
    NSLog(@"[Bridge-Observer] Stored badge count: %d", _lastBadgeCount);

    // Update the button badge with notification count
    if (_buttonWindow) {
        NSLog(@"[Bridge-Observer] Calling [_buttonWindow updateBadge:%d]", count);
        [_buttonWindow updateBadge:count];
        NSLog(@"[Bridge-Observer] [_buttonWindow updateBadge:%d] returned", count);
    } else {
        NSLog(@"[Bridge-Observer] _buttonWindow is NULL, badge will be applied when button is created");
    }

    NSLog(@"[Bridge-Observer] ========== updateButtonBadge on WordAccessibilityObserver complete ==========");
}

- (NSDictionary*)getBadgeState {
    // Get badge state for debugging
    if (_buttonWindow && _buttonWindow.badgeView) {
        CGRect badgeFrame = [_buttonWindow getBadgeFrame];
        BOOL isVisible = !_buttonWindow.badgeView.hidden;
        int count = [_buttonWindow getBadgeCount];

        return @{
            @"count": @(count),
            @"isVisible": @(isVisible),
            @"x": @(badgeFrame.origin.x),
            @"y": @(badgeFrame.origin.y),
            @"width": @(badgeFrame.size.width),
            @"height": @(badgeFrame.size.height)
        };
    }
    return nil;
}

@end

// Accessibility callback function
static void AccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon) {
    @autoreleasepool {
        WordAccessibilityObserver* self = (__bridge WordAccessibilityObserver*)refcon;

        NSString* notificationName = (__bridge NSString*)notification;

        if ([notificationName isEqualToString:(__bridge NSString*)kAXSelectedTextChangedNotification]) {
            [self handleSelectionChanged];
        } else if ([notificationName isEqualToString:(__bridge NSString*)kAXValueChangedNotification]) {
            [self handleValueChanged];
        } else if ([notificationName isEqualToString:(__bridge NSString*)kAXWindowMovedNotification]) {
            // Window moved - hide button and debounce
            [self handleWindowMoveOrResize];
        } else if ([notificationName isEqualToString:(__bridge NSString*)kAXWindowResizedNotification]) {
            // Window resized - hide button and debounce
            [self handleWindowMoveOrResize];
        }
    }
}

// Node-API bindings
namespace {

struct CallbackData {
    Napi::ThreadSafeFunction selectionTsfn;
    Napi::ThreadSafeFunction scrollTsfn;
    Napi::ThreadSafeFunction buttonClickTsfn;
};

WordAccessibilityObserver* globalObserver = nil;
CallbackData* globalCallbackData = nullptr;

void SelectionChangedCallbackBridge(const char* text, CGRect bounds) {
    if (globalCallbackData && globalCallbackData->selectionTsfn) {
        auto callback = [text = std::string(text), bounds](Napi::Env env, Napi::Function jsCallback) {
            Napi::Object event = Napi::Object::New(env);
            event.Set("type", "selectionChanged");
            event.Set("text", text);
            event.Set("x", bounds.origin.x);
            event.Set("y", bounds.origin.y);
            event.Set("width", bounds.size.width);
            event.Set("height", bounds.size.height);
            jsCallback.Call({event});
        };
        globalCallbackData->selectionTsfn.BlockingCall(callback);
    }
}

void ScrollEventCallbackBridge(bool isScrolling) {
    if (globalCallbackData && globalCallbackData->scrollTsfn) {
        auto callback = [isScrolling](Napi::Env env, Napi::Function jsCallback) {
            Napi::Object event = Napi::Object::New(env);
            event.Set("type", isScrolling ? "scrollStarted" : "scrollEnded");
            jsCallback.Call({event});
        };
        globalCallbackData->scrollTsfn.BlockingCall(callback);
    }
}

void ButtonClickCallbackBridge(const char* text) {
    if (globalCallbackData && globalCallbackData->buttonClickTsfn) {
        auto callback = [text = std::string(text)](Napi::Env env, Napi::Function jsCallback) {
            Napi::Object event = Napi::Object::New(env);
            event.Set("type", "buttonClicked");
            event.Set("text", text);
            jsCallback.Call({event});
        };
        globalCallbackData->buttonClickTsfn.BlockingCall(callback);
    }
}

Napi::Value StartObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (pid: number, callback: function)").ThrowAsJavaScriptException();
        return env.Null();
    }

    int32_t pid = info[0].As<Napi::Number>().Int32Value();
    Napi::Function callback = info[1].As<Napi::Function>();

    // Create thread-safe functions
    if (globalCallbackData) {
        delete globalCallbackData;
    }
    globalCallbackData = new CallbackData{
        Napi::ThreadSafeFunction::New(env, callback, "SelectionCallback", 0, 1),
        Napi::ThreadSafeFunction::New(env, callback, "ScrollCallback", 0, 1),
        Napi::ThreadSafeFunction::New(env, callback, "ButtonClickCallback", 0, 1)
    };

    // Create observer
    if (globalObserver) {
        [globalObserver stopObserving];
        globalObserver = nil;
    }

    globalObserver = [[WordAccessibilityObserver alloc] initWithPID:pid];

    NSError* error = nil;
    BOOL success = [globalObserver startObserving:SelectionChangedCallbackBridge
                                    scrollCallback:ScrollEventCallbackBridge
                                 buttonClickCallback:ButtonClickCallbackBridge
                                            error:&error];

    if (!success) {
        Napi::Error::New(env, error.localizedDescription.UTF8String).ThrowAsJavaScriptException();
        return env.Null();
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value StopObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (globalObserver) {
        [globalObserver stopObserving];
        globalObserver = nil;
    }

    if (globalCallbackData) {
        globalCallbackData->selectionTsfn.Release();
        globalCallbackData->scrollTsfn.Release();
        globalCallbackData->buttonClickTsfn.Release();
        delete globalCallbackData;
        globalCallbackData = nullptr;
    }

    return env.Null();
}

Napi::Value GetSelectedText(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    NSDictionary* selection = [globalObserver getSelectedText];
    if (!selection) {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("text", Napi::String::New(env, [selection[@"text"] UTF8String]));
    result.Set("x", Napi::Number::New(env, [selection[@"x"] doubleValue]));
    result.Set("y", Napi::Number::New(env, [selection[@"y"] doubleValue]));
    result.Set("width", Napi::Number::New(env, [selection[@"width"] doubleValue]));
    result.Set("height", Napi::Number::New(env, [selection[@"height"] doubleValue]));

    return result;
}

Napi::Value GetFirstTextAreaInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    NSDictionary* textAreaInfo = [globalObserver getFirstTextAreaInfo];
    if (!textAreaInfo) {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("text", Napi::String::New(env, [textAreaInfo[@"text"] UTF8String]));
    result.Set("x", Napi::Number::New(env, [textAreaInfo[@"x"] doubleValue]));
    result.Set("y", Napi::Number::New(env, [textAreaInfo[@"y"] doubleValue]));
    result.Set("width", Napi::Number::New(env, [textAreaInfo[@"width"] doubleValue]));
    result.Set("height", Napi::Number::New(env, [textAreaInfo[@"height"] doubleValue]));
    result.Set("charCount", Napi::Number::New(env, [textAreaInfo[@"charCount"] integerValue]));

    return result;
}

Napi::Value CheckPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
    BOOL hasPermission = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);

    return Napi::Boolean::New(env, hasPermission);
}

Napi::Value SetPopupPath(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected (path: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string pathStr = info[0].As<Napi::String>().Utf8Value();
    // globalPopupPath is accessible here because it's declared at file scope
    ::globalPopupPath = [NSString stringWithUTF8String:pathStr.c_str()];

    NSLog(@"[Native] Popup path set to: %@", ::globalPopupPath);

    return Napi::Boolean::New(env, true);
}

Napi::Value GetDocumentTopLeftCorner(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    CGPoint corner = [globalObserver getDocumentTopLeftCorner];

    if (CGPointEqualToPoint(corner, CGPointZero)) {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("x", Napi::Number::New(env, corner.x));
    result.Set("y", Napi::Number::New(env, corner.y));

    return result;
}

Napi::Value GetWordWindowBounds(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    CGRect bounds = [globalObserver getWordWindowBounds];

    if (CGRectIsEmpty(bounds)) {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("x", Napi::Number::New(env, bounds.origin.x));
    result.Set("y", Napi::Number::New(env, bounds.origin.y));
    result.Set("width", Napi::Number::New(env, bounds.size.width));
    result.Set("height", Napi::Number::New(env, bounds.size.height));

    return result;
}

Napi::Value GetFirstLinePosition(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    CGRect bounds = [globalObserver getFirstLinePosition];

    if (CGRectIsEmpty(bounds)) {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("x", Napi::Number::New(env, bounds.origin.x));
    result.Set("y", Napi::Number::New(env, bounds.origin.y));
    result.Set("width", Napi::Number::New(env, bounds.size.width));
    result.Set("height", Napi::Number::New(env, bounds.size.height));

    return result;
}

Napi::Value GetPageCornerVisibility(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    BOOL isVisible = [globalObserver isPageCornerVisible];
    CFRange visibleRange = [globalObserver getVisibleCharacterRange];

    Napi::Object result = Napi::Object::New(env);
    result.Set("isVisible", Napi::Boolean::New(env, isVisible));
    result.Set("inViewport", Napi::Boolean::New(env, visibleRange.location == 0 && visibleRange.length > 0));
    result.Set("visibleRangeStart", Napi::Number::New(env, visibleRange.location));
    result.Set("visibleRangeLength", Napi::Number::New(env, visibleRange.length));

    return result;
}

Napi::Value GetParentHierarchy(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    NSArray* hierarchy = [globalObserver getParentHierarchy];

    Napi::Array result = Napi::Array::New(env, hierarchy.count);

    for (NSUInteger i = 0; i < hierarchy.count; i++) {
        NSDictionary* parent = hierarchy[i];
        Napi::Object parentObj = Napi::Object::New(env);

        parentObj.Set("level", Napi::Number::New(env, [parent[@"level"] intValue]));
        parentObj.Set("role", Napi::String::New(env, [parent[@"role"] UTF8String]));
        parentObj.Set("x", Napi::Number::New(env, [parent[@"x"] doubleValue]));
        parentObj.Set("y", Napi::Number::New(env, [parent[@"y"] doubleValue]));
        parentObj.Set("width", Napi::Number::New(env, [parent[@"width"] doubleValue]));
        parentObj.Set("height", Napi::Number::New(env, [parent[@"height"] doubleValue]));

        result[i] = parentObj;
    }

    return result;
}

Napi::Value GetButtonStates(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    NSDictionary* states = [globalObserver getButtonStates];

    if (!states) {
        return env.Null();
    }

    // Convert NSDictionary to Napi::Object
    Napi::Object result = Napi::Object::New(env);

    // Academia button
    id academiaButton = states[@"academiaButton"];
    if (academiaButton == [NSNull null]) {
        result.Set("academiaButton", env.Null());
    } else {
        NSDictionary* academiaDict = (NSDictionary*)academiaButton;
        Napi::Object academiaObj = Napi::Object::New(env);
        academiaObj.Set("x", Napi::Number::New(env, [academiaDict[@"x"] doubleValue]));
        academiaObj.Set("y", Napi::Number::New(env, [academiaDict[@"y"] doubleValue]));
        academiaObj.Set("width", Napi::Number::New(env, [academiaDict[@"width"] doubleValue]));
        academiaObj.Set("height", Napi::Number::New(env, [academiaDict[@"height"] doubleValue]));
        academiaObj.Set("isVisible", Napi::Boolean::New(env, [academiaDict[@"isVisible"] boolValue]));
        result.Set("academiaButton", academiaObj);
    }

    // Count button
    id countButton = states[@"countButton"];
    if (countButton == [NSNull null]) {
        result.Set("countButton", env.Null());
    } else {
        NSDictionary* countDict = (NSDictionary*)countButton;
        Napi::Object countObj = Napi::Object::New(env);
        countObj.Set("x", Napi::Number::New(env, [countDict[@"x"] doubleValue]));
        countObj.Set("y", Napi::Number::New(env, [countDict[@"y"] doubleValue]));
        countObj.Set("width", Napi::Number::New(env, [countDict[@"width"] doubleValue]));
        countObj.Set("height", Napi::Number::New(env, [countDict[@"height"] doubleValue]));
        countObj.Set("isVisible", Napi::Boolean::New(env, [countDict[@"isVisible"] boolValue]));
        result.Set("countButton", countObj);
    }

    return result;
}

Napi::Value GetScrollAreaBounds(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    CGRect bounds = [globalObserver getScrollAreaBounds];

    if (CGRectIsEmpty(bounds)) {
        return env.Null();
    }

    // Convert CGRect to Napi::Object
    Napi::Object result = Napi::Object::New(env);
    result.Set("x", Napi::Number::New(env, bounds.origin.x));
    result.Set("y", Napi::Number::New(env, bounds.origin.y));
    result.Set("width", Napi::Number::New(env, bounds.size.width));
    result.Set("height", Napi::Number::New(env, bounds.size.height));

    return result;
}

Napi::Value UpdateButtonBadge(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    NSLog(@"[Bridge-N-API] ========== UpdateButtonBadge N-API function called ==========");

    if (info.Length() < 1 || !info[0].IsNumber()) {
        NSLog(@"[Bridge-N-API] ERROR: Invalid arguments");
        Napi::TypeError::New(env, "Expected (count: number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    int32_t count = info[0].As<Napi::Number>().Int32Value();
    NSLog(@"[Bridge-N-API] Received count: %d", count);

    if (!globalObserver) {
        NSLog(@"[Bridge-N-API] ERROR: globalObserver is NULL!");
        return env.Null();
    }

    NSLog(@"[Bridge-N-API] globalObserver exists, dispatching to main queue");
    // Update badge on the button window via the observer's public method
    dispatch_async(dispatch_get_main_queue(), ^{
        NSLog(@"[Bridge-N-API] Now on main queue, calling [globalObserver updateButtonBadge:%d]", count);
        [globalObserver updateButtonBadge:count];
        NSLog(@"[Bridge-N-API] [globalObserver updateButtonBadge:%d] returned", count);
    });

    NSLog(@"[Bridge-N-API] dispatch_async queued, returning from N-API function");
    return env.Null();
}

Napi::Value GetBadgeState(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!globalObserver) {
        return env.Null();
    }

    NSDictionary* badgeState = [globalObserver getBadgeState];

    if (badgeState == nil) {
        return env.Null();
    }

    // Convert NSDictionary to Napi::Object
    Napi::Object result = Napi::Object::New(env);
    result.Set("count", Napi::Number::New(env, [badgeState[@"count"] intValue]));
    result.Set("isVisible", Napi::Boolean::New(env, [badgeState[@"isVisible"] boolValue]));
    result.Set("x", Napi::Number::New(env, [badgeState[@"x"] doubleValue]));
    result.Set("y", Napi::Number::New(env, [badgeState[@"y"] doubleValue]));
    result.Set("width", Napi::Number::New(env, [badgeState[@"width"] doubleValue]));
    result.Set("height", Napi::Number::New(env, [badgeState[@"height"] doubleValue]));

    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startObserving", Napi::Function::New(env, StartObserving));
    exports.Set("stopObserving", Napi::Function::New(env, StopObserving));
    exports.Set("getSelectedText", Napi::Function::New(env, GetSelectedText));
    exports.Set("getFirstTextAreaInfo", Napi::Function::New(env, GetFirstTextAreaInfo));
    exports.Set("checkPermission", Napi::Function::New(env, CheckPermission));
    exports.Set("setPopupPath", Napi::Function::New(env, SetPopupPath));
    exports.Set("getDocumentTopLeftCorner", Napi::Function::New(env, GetDocumentTopLeftCorner));
    exports.Set("getWordWindowBounds", Napi::Function::New(env, GetWordWindowBounds));
    exports.Set("getFirstLinePosition", Napi::Function::New(env, GetFirstLinePosition));
    exports.Set("getPageCornerVisibility", Napi::Function::New(env, GetPageCornerVisibility));
    exports.Set("getParentHierarchy", Napi::Function::New(env, GetParentHierarchy));
    exports.Set("getButtonStates", Napi::Function::New(env, GetButtonStates));
    exports.Set("getScrollAreaBounds", Napi::Function::New(env, GetScrollAreaBounds));
    exports.Set("updateButtonBadge", Napi::Function::New(env, UpdateButtonBadge));
    exports.Set("getBadgeState", Napi::Function::New(env, GetBadgeState));
    return exports;
}

} // namespace

NODE_API_MODULE(word_accessibility, Init)
