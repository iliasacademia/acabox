#import "bridge.h"
#import <napi.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// Forward declaration
@class WordAccessibilityObserver;

// Import extracted window classes
#import "bridge/windows/OverallReviewPopup.h"
#import "bridge/windows/AcademiaNotificationsButton.h"
#import "bridge/windows/OverallReviewButton.h"
#import "bridge/windows/TextSideButton.h"

// Import new architecture components (WAGENT-94)
#import "bridge/adapters/MicrosoftWordAdapter.h"
#import "bridge/managers/AcademiaManager.h"

// Import debug windows (WAGENT-94)
#import "bridge/windows/DebugBorderWindow.h"
#import "bridge/windows/DebugInfoOverlay.h"


// Global variable for popup path (declared at file scope for accessibility from both Obj-C and C++)
NSString* globalPopupPath = nil;

// Global variable for HTTP server base URL (e.g., "http://127.0.0.1:23111")
NSString* globalServerBaseUrl = nil;

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
    id _spaceChangeObserver;
    id _appActivationObserver;

    // WAGENT-94: New architecture components
    MicrosoftWordAdapter* _wordAdapter;  // Handles Word state tracking
    AcademiaManager* _academiaManager;   // Coordinates overlay windows
    BOOL _useNewArchitecture;  // Feature flag to enable/disable new architecture

    // Overlay windows
    AcademiaNotificationsButton* _notificationsButton;
    OverallReviewButton* _overallReviewButton;
    TextSideButton* _textSideButton;

    // Debug windows (enabled with DEBUG=1)
    DebugBorderWindow* _debugWindowBorder;     // Red border for Word window
    DebugBorderWindow* _debugScrollBorder;     // Blue border for scroll area
    DebugBorderWindow* _debugDocumentBorder;   // Green border for layout container
    DebugInfoOverlay* _debugInfoOverlay;       // Info overlay at bottom-right
}

- (instancetype)initWithPID:(pid_t)pid {
    self = [super init];
    if (self) {
        _pid = pid;
        _wordApp = AXUIElementCreateApplication(pid);
        _observer = NULL;

        // WAGENT-94: Initialize new architecture components
        _useNewArchitecture = YES;
        NSLog(@"[Bridge] WAGENT-94: Initializing new architecture (MicrosoftWordAdapter + AcademiaManager)");

        // Create Word adapter with self as delegate
        _wordAdapter = [[MicrosoftWordAdapter alloc] initWithPID:pid delegate:nil];

        // Create Academia manager with the adapter
        _academiaManager = [[AcademiaManager alloc] initWithWordAdapter:_wordAdapter];

        // Create and register overlay windows
        _notificationsButton = [[AcademiaNotificationsButton alloc] initWithObserver:self];
        _overallReviewButton = [[OverallReviewButton alloc] initWithObserver:self];
        _textSideButton = [[TextSideButton alloc] initWithObserver:self searchText:@"My default assumption about the universe is that the universe is teeming with advanced life"];

        [_academiaManager registerOverlay:_notificationsButton];
        [_academiaManager registerOverlay:_overallReviewButton];
        [_academiaManager registerOverlay:_textSideButton];

        // Check if debug mode is enabled via DEBUG=1 environment variable
        NSString* debugEnv = [[[NSProcessInfo processInfo] environment] objectForKey:@"DEBUG"];
        BOOL isDebugMode = [debugEnv isEqualToString:@"1"];

        if (isDebugMode) {
            NSLog(@"[Bridge] DEBUG: Debug mode enabled, creating debug windows");

            // Create debug border windows with appropriate colors
            _debugWindowBorder = [[DebugBorderWindow alloc] initWithBorderType:DebugBorderTypeWordWindow
                                                                         color:[NSColor redColor]];
            _debugScrollBorder = [[DebugBorderWindow alloc] initWithBorderType:DebugBorderTypeScrollArea
                                                                         color:[NSColor blueColor]];
            _debugDocumentBorder = [[DebugBorderWindow alloc] initWithBorderType:DebugBorderTypeLayout
                                                                           color:[NSColor greenColor]];

            // Create debug info overlay
            _debugInfoOverlay = [[DebugInfoOverlay alloc] init];

            // Register all debug windows with the manager
            [_academiaManager registerOverlay:_debugWindowBorder];
            [_academiaManager registerOverlay:_debugScrollBorder];
            [_academiaManager registerOverlay:_debugDocumentBorder];
            [_academiaManager registerOverlay:_debugInfoOverlay];

            NSLog(@"[Bridge] DEBUG: Created and registered 4 debug windows (3 borders + 1 info overlay)");
        }

        NSLog(@"[Bridge] WAGENT-94: New architecture components initialized with %ld overlays",
              (long)[_academiaManager registeredOverlayCount]);
    }
    return self;
}

- (void)dealloc {
    [self stopObserving];

    // Clean up debug windows
    if (_debugWindowBorder) {
        [_debugWindowBorder close];
        _debugWindowBorder = nil;
    }
    if (_debugScrollBorder) {
        [_debugScrollBorder close];
        _debugScrollBorder = nil;
    }
    if (_debugDocumentBorder) {
        [_debugDocumentBorder close];
        _debugDocumentBorder = nil;
    }
    if (_debugInfoOverlay) {
        [_debugInfoOverlay close];
        _debugInfoOverlay = nil;
    }

    // WAGENT-94: Clean up new architecture components
    if (_academiaManager) {
        [_academiaManager stopManaging];
        _academiaManager = nil;
    }
    if (_wordAdapter) {
        [_wordAdapter stopObserving];
        _wordAdapter = nil;
    }
    NSLog(@"[Bridge] WAGENT-94: New architecture components cleaned up");

    if (_wordApp) {
        CFRelease(_wordApp);
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

    // WAGENT-94: Start new architecture if enabled
    if (_useNewArchitecture) {
        NSLog(@"[Bridge] WAGENT-94: Starting new architecture components");

        // Start Word adapter observation
        NSError *adapterError = nil;
        if (![_wordAdapter startObserving:&adapterError]) {
            NSLog(@"[Bridge] WAGENT-94: ERROR - Failed to start Word adapter: %@", adapterError);
            if (error) {
                *error = adapterError;
            }
            return NO;
        }

        // Start Academia manager
        if (![_academiaManager startManaging]) {
            NSLog(@"[Bridge] WAGENT-94: ERROR - Failed to start Academia manager");
            if (error) {
                *error = [NSError errorWithDomain:@"WordAccessibility"
                                            code:3
                                        userInfo:@{NSLocalizedDescriptionKey: @"Failed to start Academia manager"}];
            }
            return NO;
        }

        NSLog(@"[Bridge] WAGENT-94: New architecture started successfully");

        // Note: With new architecture, the manager handles overlay coordination
        // Legacy app activation observer below is still active for compatibility
    }

    // Listen for app activation/deactivation (handled by new architecture)
    __weak typeof(self) weakSelf = self;
    _appActivationObserver = [[NSWorkspace sharedWorkspace].notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) return;

        NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];

        NSLog(@"[Bridge] ===== APP ACTIVATION =====");
        NSLog(@"[Bridge] Active app: %@ (PID: %d)", app.localizedName, app.processIdentifier);
        NSLog(@"[Bridge] Word PID: %d", strongSelf->_pid);

        // WAGENT-94: New architecture handles all overlay visibility
        if (strongSelf->_useNewArchitecture) {
            if (app.processIdentifier == strongSelf->_pid) {
                NSLog(@"[Bridge] Word activated - new architecture handling overlays");
            } else {
                NSLog(@"[Bridge] Different app activated - new architecture handling overlays");
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

    // WAGENT-94: New architecture handles initial overlay display
    NSLog(@"[Bridge] startObserving completed - new architecture managing overlays");

    return YES;
}

- (void)stopObserving {
    // WAGENT-94: New architecture cleanup is handled in dealloc
    NSLog(@"[Bridge] stopObserving - cleaning up observers");

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

}

#pragma mark - Legacy Button Methods Removed (Replaced by New Architecture)

#pragma mark - Space Change Handler

- (void)handleSpaceChange {
    // WAGENT-94: New architecture handles overlay hiding via AcademiaManager
    // This method is called by _spaceChangeObserver but new architecture
    // handles space changes through its own mechanisms
    NSLog(@"[Bridge] Space change detected - new architecture handling");
}

#pragma mark - Legacy Click Popup Observers (No-op in New Architecture)

- (void)registerClickPopupObservers {
    // WAGENT-94: No-op - new architecture handles popup events
    NSLog(@"[Bridge] registerClickPopupObservers called (no-op in new architecture)");
}

- (void)unregisterClickPopupObservers {
    // WAGENT-94: No-op - new architecture handles popup events
    NSLog(@"[Bridge] unregisterClickPopupObservers called (no-op in new architecture)");
}

#pragma mark - Button Click Handlers

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

#pragma mark - Legacy Duplicate Position Query Methods (Now Delegated to Adapter)
// The following methods delegate to MicrosoftWordAdapter for WAGENT-94 refactoring

- (CGPoint)getDocumentTopLeftCorner {
    if (_useNewArchitecture && _wordAdapter) {
        return [_wordAdapter getLayoutBounds].origin;
    }
    return CGPointZero;
}

- (CGRect)getScrollAreaBounds {
    if (_useNewArchitecture && _wordAdapter) {
        return [_wordAdapter getScrollAreaBounds];
    }
    return CGRectZero;
}

- (CGRect)getFirstLinePosition {
    if (_useNewArchitecture && _wordAdapter) {
        return [_wordAdapter getFirstLinePosition];
    }
    return CGRectZero;
}

- (CFRange)getVisibleCharacterRange {
    if (_useNewArchitecture && _wordAdapter) {
        return [_wordAdapter getVisibleCharacterRange];
    }
    return CFRangeMake(0, 0);
}

- (BOOL)isPageCornerVisible {
    if (_useNewArchitecture && _wordAdapter) {
        return [_wordAdapter isPageCornerVisible];
    }
    return NO;
}

- (CGRect)getWordWindowBounds {
    if (_useNewArchitecture && _wordAdapter) {
        return [_wordAdapter getWordWindowBounds];
    }
    return CGRectZero;
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

#pragma mark - Button State Query (Used by N-API)

- (NSDictionary*)getButtonStates {
    // WAGENT-94: Legacy buttons removed - return null for both
    // New architecture manages overlays through AcademiaManager
    return @{
        @"academiaButton": [NSNull null],
        @"countButton": [NSNull null]
    };
}

#pragma mark - Legacy Scroll Detection and Badge Methods Removed
// The following methods have been removed (replaced by new architecture):
// - checkPositionChange (selection-based scroll detection)
// - handleSelectionChanged (disabled notification handler)
// - handleValueChanged (disabled notification handler)
// - updateButtonBadge (removed - use updateBadgeCountViaManager from Objective-C)
// - getBadgeState (removed - debug method for legacy badge system)

#pragma mark - WAGENT-94: New Architecture Access Methods

/**
 * Enable the new architecture (MicrosoftWordAdapter + AcademiaManager)
 * Must be called BEFORE startObserving
 *
 * @return YES if enabled successfully, NO if already observing
 */
- (BOOL)enableNewArchitecture {
    // Cannot enable if already observing (must be set before startObserving)
    if (_observer != NULL) {
        NSLog(@"[Bridge] WAGENT-94: ERROR - Cannot enable new architecture after startObserving has been called");
        return NO;
    }

    if (_useNewArchitecture) {
        NSLog(@"[Bridge] WAGENT-94: New architecture already enabled");
        return YES;
    }

    NSLog(@"[Bridge] WAGENT-94: Enabling new architecture");
    _useNewArchitecture = YES;

    // Initialize components (will be started in startObserving)
    _wordAdapter = [[MicrosoftWordAdapter alloc] initWithPID:_pid delegate:nil];
    _academiaManager = [[AcademiaManager alloc] initWithWordAdapter:_wordAdapter];

    NSLog(@"[Bridge] WAGENT-94: New architecture enabled (components will start with startObserving)");
    return YES;
}

/**
 * Check if new architecture is enabled
 */
- (BOOL)isUsingNewArchitecture {
    return _useNewArchitecture;
}

/**
 * Get the Word adapter instance (WAGENT-94)
 * Returns nil if new architecture is not enabled
 */
- (MicrosoftWordAdapter *)getWordAdapter {
    return _wordAdapter;
}

/**
 * Get the Academia manager instance (WAGENT-94)
 * Returns nil if new architecture is not enabled
 */
- (AcademiaManager *)getAcademiaManager {
    return _academiaManager;
}

/**
 * Update badge count via new architecture manager
 *
 * @param count Badge count to display
 */
- (void)updateBadgeCountViaManager:(NSInteger)count {
    if (_useNewArchitecture && _academiaManager) {
        NSLog(@"[Bridge] WAGENT-94: Updating badge count via AcademiaManager: %ld", (long)count);
        [_academiaManager updateBadgeCount:count];
    } else {
        NSLog(@"[Bridge] WAGENT-94: ERROR - New architecture not initialized, cannot update badge");
    }
}

@end

// Accessibility callback function
static void AccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon) {
    @autoreleasepool {
        NSString* notificationName = (__bridge NSString*)notification;

        // WAGENT-94: Legacy notification handlers removed - new architecture handles all events
        NSLog(@"[Bridge] Received accessibility notification: %@", notificationName);

        // Note: Window move/resize events are logged but handled by new architecture
        if ([notificationName isEqualToString:(__bridge NSString*)kAXWindowMovedNotification] ||
            [notificationName isEqualToString:(__bridge NSString*)kAXWindowResizedNotification]) {
            NSLog(@"[Bridge] Window geometry change - new architecture will update overlays");
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

Napi::Value SetServerBaseUrl(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected (url: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string urlStr = info[0].As<Napi::String>().Utf8Value();
    // globalServerBaseUrl is accessible here because it's declared at file scope
    ::globalServerBaseUrl = [NSString stringWithUTF8String:urlStr.c_str()];

    NSLog(@"[Native] Server base URL set to: %@", ::globalServerBaseUrl);

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

// WAGENT-94: Legacy badge N-API functions removed - badges handled by AcademiaManager

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startObserving", Napi::Function::New(env, StartObserving));
    exports.Set("stopObserving", Napi::Function::New(env, StopObserving));
    exports.Set("getSelectedText", Napi::Function::New(env, GetSelectedText));
    exports.Set("getFirstTextAreaInfo", Napi::Function::New(env, GetFirstTextAreaInfo));
    exports.Set("checkPermission", Napi::Function::New(env, CheckPermission));
    exports.Set("setPopupPath", Napi::Function::New(env, SetPopupPath));
    exports.Set("setServerBaseUrl", Napi::Function::New(env, SetServerBaseUrl));
    exports.Set("getDocumentTopLeftCorner", Napi::Function::New(env, GetDocumentTopLeftCorner));
    exports.Set("getWordWindowBounds", Napi::Function::New(env, GetWordWindowBounds));
    exports.Set("getFirstLinePosition", Napi::Function::New(env, GetFirstLinePosition));
    exports.Set("getPageCornerVisibility", Napi::Function::New(env, GetPageCornerVisibility));
    exports.Set("getParentHierarchy", Napi::Function::New(env, GetParentHierarchy));
    exports.Set("getButtonStates", Napi::Function::New(env, GetButtonStates));
    exports.Set("getScrollAreaBounds", Napi::Function::New(env, GetScrollAreaBounds));
    // WAGENT-94: Badge functions removed - handled by AcademiaManager
    return exports;
}

} // namespace

NODE_API_MODULE(word_accessibility, Init)
