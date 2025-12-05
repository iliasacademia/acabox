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

// Import architecture components
#import "bridge/adapters/MicrosoftWordAdapter.h"
#import "bridge/managers/AcademiaManager.h"

// Import debug windows
#import "bridge/windows/DebugBorderWindow.h"
#import "bridge/windows/DebugInfoOverlay.h"


// Global variable for popup path (declared at file scope for accessibility from both Obj-C and C++)
NSString* globalPopupPath = nil;

// Global variable for HTTP server base URL (e.g., "http://127.0.0.1:23111")
NSString* globalServerBaseUrl = nil;

// Feature flags (set from TypeScript via setFeatureFlags)
// Declared at file scope for accessibility from both Obj-C implementation and C++ namespace
static BOOL featureTextSideButtonEnabled = YES;      // Default: enabled
static BOOL featureOverallReviewButtonEnabled = YES; // Default: enabled
BOOL featureScrollTrackingEnabled = YES;             // Default: enabled (non-static for extern access)

// Global variable for HTTP server auth token
NSString* globalAuthToken = nil;

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

    // New architecture components
    MicrosoftWordAdapter* _wordAdapter;  // Handles Word state tracking
    AcademiaManager* _academiaManager;   // Coordinates overlay windows

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

        // Create Word adapter with self as delegate
        _wordAdapter = [[MicrosoftWordAdapter alloc] initWithPID:pid delegate:nil];

        // Create Academia manager with the adapter
        _academiaManager = [[AcademiaManager alloc] initWithWordAdapter:_wordAdapter];

        // Create and register overlay windows
        // Notifications button is always enabled
        _notificationsButton = [[AcademiaNotificationsButton alloc] initWithObserver:self];
        [_academiaManager registerOverlay:_notificationsButton];

        // OverallReviewButton - conditionally created based on feature flag
        if (featureOverallReviewButtonEnabled) {
            _overallReviewButton = [[OverallReviewButton alloc] initWithObserver:self];
            [_academiaManager registerOverlay:_overallReviewButton];
        } else {
            _overallReviewButton = nil;
        }

        // TextSideButton - conditionally created based on feature flag
        if (featureTextSideButtonEnabled) {
            _textSideButton = [[TextSideButton alloc] initWithObserver:self searchText:@"Introduction"];
            [_academiaManager registerOverlay:_textSideButton];
        } else {
            _textSideButton = nil;
        }

        // Check if debug mode is enabled via DEBUG=1 environment variable
        NSString* debugEnv = [[[NSProcessInfo processInfo] environment] objectForKey:@"DEBUG"];
        BOOL isDebugMode = [debugEnv isEqualToString:@"1"];

        if (isDebugMode) {
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
        }
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

    // Note: Architecture components are cleaned up in stopObserving (called above)

    if (_wordApp) {
        CFRelease(_wordApp);
    }
}

- (BOOL)checkAccessibilityPermission {
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @NO};
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

    // Start architecture components

    // Start Word adapter observation
    NSError *adapterError = nil;
    if (![_wordAdapter startObserving:&adapterError]) {
        NSLog(@"[Bridge] ERROR: Failed to start Word adapter: %@", adapterError);
        if (error) {
            *error = adapterError;
        }
        return NO;
    }

    // Start Academia manager
    if (![_academiaManager startManaging]) {
        NSLog(@"[Bridge] ERROR: Failed to start Academia manager");
        if (error) {
            *error = [NSError errorWithDomain:@"WordAccessibility"
                                        code:3
                                    userInfo:@{NSLocalizedDescriptionKey: @"Failed to start Academia manager"}];
        }
        return NO;
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

        // App activation is handled by architecture - no action needed here
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

    return YES;
}

- (void)stopObserving {
    // Clean up architecture components FIRST (synchronous cleanup)
    if (_academiaManager) {
        [_academiaManager stopManaging];
        _academiaManager = nil;
    }
    if (_wordAdapter) {
        [_wordAdapter stopObserving];
        _wordAdapter = nil;
    }

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

#pragma mark - Space Change Handler

- (void)handleSpaceChange {
    // Space change handling is managed by AcademiaManager
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

    // Try to set focus on the text area
    error = AXUIElementSetAttributeValue(textAreaElement, kAXFocusedAttribute, kCFBooleanTrue);

    CFRelease(textAreaElement);

    if (error != kAXErrorSuccess) {
        NSLog(@"[Bridge] ERROR: Could not set focus (error: %d)", error);
        CFRelease(windowsRef);
        return NO;
    }

    CFRelease(windowsRef);
    return YES;
}

- (NSDictionary*)findTextPosition:(NSString*)searchText {
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

    // Verify this is a text area
    CFTypeRef roleValue = NULL;
    AXUIElementCopyAttributeValue(focusedElement, kAXRoleAttribute, &roleValue);
    NSString* role = (__bridge_transfer NSString*)roleValue;

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

    // Search for the text (case-insensitive)
    NSRange searchRange = [fullText rangeOfString:searchText options:NSCaseInsensitiveSearch];

    if (searchRange.location == NSNotFound) {
        CFRelease(focusedElement);
        return @{
            @"found": @NO,
            @"text": searchText
        };
    }

    // Found! Now get the bounds for this text range
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
        CFRelease(boundsValue);
    } else {
        NSLog(@"[Bridge] WARNING: Could not get bounds (error: %d)", error);
    }

    CFRelease(rangeValue);
    CFRelease(focusedElement);

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

#pragma mark - Position Query Methods (Delegated to Adapter)

- (CGPoint)getDocumentTopLeftCorner {
    return [_wordAdapter getLayoutBounds].origin;
}

- (CGRect)getScrollAreaBounds {
    return [_wordAdapter getScrollAreaBounds];
}

- (CGRect)getFirstLinePosition {
    return [_wordAdapter getFirstLinePosition];
}

- (CFRange)getVisibleCharacterRange {
    return [_wordAdapter getVisibleCharacterRange];
}

- (BOOL)isPageCornerVisible {
    return [_wordAdapter isPageCornerVisible];
}

- (CGRect)getWordWindowBounds {
    return [_wordAdapter getWordWindowBounds];
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
    // Legacy buttons removed - return null for both
    // Overlays are managed through AcademiaManager
    return @{
        @"academiaButton": [NSNull null],
        @"countButton": [NSNull null]
    };
}

/**
 * Get the Word adapter instance
 */
- (MicrosoftWordAdapter *)getWordAdapter {
    return _wordAdapter;
}

/**
 * Get the Academia manager instance
 */
- (AcademiaManager *)getAcademiaManager {
    return _academiaManager;
}

/**
 * Update badge count via manager
 *
 * @param count Badge count to display
 */
- (void)updateBadgeCountViaManager:(NSInteger)count {
    [_academiaManager updateBadgeCount:count];
}

@end

// Accessibility callback function
static void AccessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void* refcon) {
    @autoreleasepool {
        // Window move/resize events are handled by architecture
    }
}

// Node-API bindings
namespace {

struct CallbackData {
    Napi::ThreadSafeFunction selectionTsfn;
    Napi::ThreadSafeFunction scrollTsfn;
    Napi::ThreadSafeFunction buttonClickTsfn;
};

// Multi-PID observer registry (Phase 2 implementation)
NSMutableDictionary<NSNumber*, WordAccessibilityObserver*>* observerRegistry = nil;
NSNumber* activePID = nil;  // Currently focused Word PID
CallbackData* globalCallbackData = nullptr;  // Shared across all observers
static const NSInteger kMaxObservers = 3;  // Prioritizes first-opened PIDs
static id appActivationObserver = nil;  // Focus monitor observer

// Legacy single-observer support (deprecated)
WordAccessibilityObserver* globalObserver = nil;

// Registry helper functions
static void initializeRegistry() {
    if (!observerRegistry) {
        observerRegistry = [[NSMutableDictionary alloc] init];
    }
}

static void setActiveObserver(pid_t pid) {
    initializeRegistry();
    NSNumber* pidKey = @(pid);

    // Only proceed if this PID is in our registry
    if (!observerRegistry[pidKey]) {
        return;
    }

    activePID = pidKey;

    // Hide overlays on all other observers, show on active
    for (NSNumber* key in observerRegistry) {
        WordAccessibilityObserver* observer = observerRegistry[key];
        AcademiaManager* manager = [observer getAcademiaManager];
        if ([key isEqualToNumber:activePID]) {
            [manager showAllOverlays];
        } else {
            [manager hideAllOverlays];
        }
    }
}

static void setupGlobalFocusMonitor() {
    if (appActivationObserver) return;

    appActivationObserver = [[NSWorkspace sharedWorkspace].notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
        NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
        pid_t activatedPID = app.processIdentifier;

        initializeRegistry();

        // Check if activated app is one of our tracked Word processes
        NSNumber* activatedKey = @(activatedPID);

        if (observerRegistry[activatedKey]) {
            // One of our Word processes activated
            setActiveObserver(activatedPID);
        } else {
            // Different app activated - hide all Word overlays
            for (WordAccessibilityObserver* observer in observerRegistry.allValues) {
                AcademiaManager* manager = [observer getAcademiaManager];
                [manager hideAllOverlays];
            }
        }
    }];
}

static void teardownGlobalFocusMonitor() {
    if (appActivationObserver) {
        [[NSWorkspace sharedWorkspace].notificationCenter removeObserver:appActivationObserver];
        appActivationObserver = nil;
    }
}

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

// DEPRECATED: Use StartObservingPID instead for multi-PID support
Napi::Value StartObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    NSLog(@"[Bridge] WARNING: startObserving() is deprecated. Use startObservingPID() for multi-PID support.");

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

// DEPRECATED: Use StopObservingPID or StopAllObserving instead for multi-PID support
Napi::Value StopObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    NSLog(@"[Bridge] WARNING: stopObserving() is deprecated. Use stopObservingPID() or stopAllObserving() for multi-PID support.");

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

// ============================================================================
// Multi-PID Observer API (Phase 2)
// ============================================================================

Napi::Value StartObservingPID(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (pid: number, callback: function)").ThrowAsJavaScriptException();
        return env.Null();
    }

    initializeRegistry();

    // Check max observer limit
    if ((NSInteger)observerRegistry.count >= kMaxObservers) {
        Napi::Error::New(env, "Maximum observer limit (10) reached").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    int32_t pid = info[0].As<Napi::Number>().Int32Value();
    NSNumber* pidKey = @(pid);

    // Check if already observing this PID
    if (observerRegistry[pidKey]) {
        return Napi::Boolean::New(env, true);
    }

    Napi::Function callback = info[1].As<Napi::Function>();

    // Create/update thread-safe callback (shared across all observers)
    if (!globalCallbackData) {
        globalCallbackData = new CallbackData{
            Napi::ThreadSafeFunction::New(env, callback, "SelectionCallback", 0, 1),
            Napi::ThreadSafeFunction::New(env, callback, "ScrollCallback", 0, 1),
            Napi::ThreadSafeFunction::New(env, callback, "ButtonClickCallback", 0, 1)
        };
    }

    // Create new observer for this PID
    WordAccessibilityObserver* observer = [[WordAccessibilityObserver alloc] initWithPID:pid];

    NSError* error = nil;
    BOOL success = [observer startObserving:SelectionChangedCallbackBridge
                              scrollCallback:ScrollEventCallbackBridge
                           buttonClickCallback:ButtonClickCallbackBridge
                                        error:&error];

    if (!success) {
        Napi::Error::New(env, error.localizedDescription.UTF8String).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Add to registry
    observerRegistry[pidKey] = observer;

    // Setup focus monitor if this is the first observer
    if (observerRegistry.count == 1) {
        setupGlobalFocusMonitor();
        activePID = pidKey;  // First observer is active by default
    } else {
        // Hide overlays for non-active observers
        if (![pidKey isEqualToNumber:activePID]) {
            [[observer getAcademiaManager] hideAllOverlays];
        }
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value StopObservingPID(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected (pid: number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    int32_t pid = info[0].As<Napi::Number>().Int32Value();
    NSNumber* pidKey = @(pid);

    initializeRegistry();

    WordAccessibilityObserver* observer = observerRegistry[pidKey];
    if (!observer) {
        return Napi::Boolean::New(env, false);
    }

    // Stop and remove observer
    [observer stopObserving];
    [observerRegistry removeObjectForKey:pidKey];

    // If we removed the active PID, activate the next available one
    if ([pidKey isEqualToNumber:activePID]) {
        activePID = nil;
        NSNumber* nextPID = observerRegistry.allKeys.firstObject;
        if (nextPID) {
            setActiveObserver(nextPID.intValue);
        }
    }

    // Teardown focus monitor if no more observers
    if (observerRegistry.count == 0) {
        teardownGlobalFocusMonitor();

        // Also release shared callback data
        if (globalCallbackData) {
            globalCallbackData->selectionTsfn.Release();
            globalCallbackData->scrollTsfn.Release();
            globalCallbackData->buttonClickTsfn.Release();
            delete globalCallbackData;
            globalCallbackData = nullptr;
        }
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value StopAllObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    initializeRegistry();

    // Stop all observers
    for (WordAccessibilityObserver* observer in observerRegistry.allValues) {
        [observer stopObserving];
    }
    [observerRegistry removeAllObjects];
    activePID = nil;

    // Teardown focus monitor
    teardownGlobalFocusMonitor();

    // Release shared callback data
    if (globalCallbackData) {
        globalCallbackData->selectionTsfn.Release();
        globalCallbackData->scrollTsfn.Release();
        globalCallbackData->buttonClickTsfn.Release();
        delete globalCallbackData;
        globalCallbackData = nullptr;
    }

    return env.Null();
}

Napi::Value SetActivePID(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected (pid: number)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    int32_t pid = info[0].As<Napi::Number>().Int32Value();

    initializeRegistry();

    if (!observerRegistry[@(pid)]) {
        return Napi::Boolean::New(env, false);
    }

    setActiveObserver(pid);
    return Napi::Boolean::New(env, true);
}

Napi::Value GetActivePID(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!activePID) {
        return env.Null();
    }

    return Napi::Number::New(env, activePID.intValue);
}

Napi::Value GetObservedPIDs(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    initializeRegistry();

    Napi::Array result = Napi::Array::New(env, observerRegistry.count);
    NSUInteger index = 0;
    for (NSNumber* pidKey in observerRegistry) {
        result.Set(index++, Napi::Number::New(env, pidKey.intValue));
    }

    return result;
}

Napi::Value IsObservingPID(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected (pid: number)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    int32_t pid = info[0].As<Napi::Number>().Int32Value();

    initializeRegistry();

    BOOL isObserving = observerRegistry[@(pid)] != nil;
    return Napi::Boolean::New(env, isObserving);
}

// ============================================================================
// Legacy Single-Observer API (getter functions use globalObserver for backward compat)
// ============================================================================

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

    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @NO};
    BOOL hasPermission = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);

    return Napi::Boolean::New(env, hasPermission);
}

Napi::Value RequestPermission(const Napi::CallbackInfo& info) {
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

    return Napi::Boolean::New(env, true);
}

Napi::Value SetAuthToken(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected (token: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string tokenStr = info[0].As<Napi::String>().Utf8Value();
    // globalAuthToken is accessible here because it's declared at file scope
    ::globalAuthToken = [NSString stringWithUTF8String:tokenStr.c_str()];

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

// ============================================================================
// Feature Flag Configuration
// ============================================================================

Napi::Value SetFeatureFlags(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected (flags: object)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    Napi::Object flags = info[0].As<Napi::Object>();

    if (flags.Has("textSideButtonEnabled")) {
        featureTextSideButtonEnabled = flags.Get("textSideButtonEnabled").As<Napi::Boolean>().Value();
    }
    if (flags.Has("overallReviewButtonEnabled")) {
        featureOverallReviewButtonEnabled = flags.Get("overallReviewButtonEnabled").As<Napi::Boolean>().Value();
    }
    if (flags.Has("scrollTrackingEnabled")) {
        featureScrollTrackingEnabled = flags.Get("scrollTrackingEnabled").As<Napi::Boolean>().Value();
    }

    NSLog(@"[Bridge] Feature flags set - TextSide: %@, OverallReview: %@, ScrollTracking: %@",
          featureTextSideButtonEnabled ? @"ON" : @"OFF",
          featureOverallReviewButtonEnabled ? @"ON" : @"OFF",
          featureScrollTrackingEnabled ? @"ON" : @"OFF");

    return Napi::Boolean::New(env, true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Legacy single-observer API (deprecated but still functional)
    exports.Set("startObserving", Napi::Function::New(env, StartObserving));
    exports.Set("stopObserving", Napi::Function::New(env, StopObserving));

    // Multi-PID observer API (Phase 2)
    exports.Set("startObservingPID", Napi::Function::New(env, StartObservingPID));
    exports.Set("stopObservingPID", Napi::Function::New(env, StopObservingPID));
    exports.Set("stopAllObserving", Napi::Function::New(env, StopAllObserving));
    exports.Set("setActivePID", Napi::Function::New(env, SetActivePID));
    exports.Set("getActivePID", Napi::Function::New(env, GetActivePID));
    exports.Set("getObservedPIDs", Napi::Function::New(env, GetObservedPIDs));
    exports.Set("isObservingPID", Napi::Function::New(env, IsObservingPID));

    // Configuration
    exports.Set("setFeatureFlags", Napi::Function::New(env, SetFeatureFlags));

    // Utility functions
    exports.Set("getSelectedText", Napi::Function::New(env, GetSelectedText));
    exports.Set("getFirstTextAreaInfo", Napi::Function::New(env, GetFirstTextAreaInfo));
    exports.Set("checkPermission", Napi::Function::New(env, CheckPermission));
    exports.Set("requestPermission", Napi::Function::New(env, RequestPermission));
    exports.Set("setPopupPath", Napi::Function::New(env, SetPopupPath));
    exports.Set("setServerBaseUrl", Napi::Function::New(env, SetServerBaseUrl));
    exports.Set("setAuthToken", Napi::Function::New(env, SetAuthToken));
    exports.Set("getDocumentTopLeftCorner", Napi::Function::New(env, GetDocumentTopLeftCorner));
    exports.Set("getWordWindowBounds", Napi::Function::New(env, GetWordWindowBounds));
    exports.Set("getFirstLinePosition", Napi::Function::New(env, GetFirstLinePosition));
    exports.Set("getPageCornerVisibility", Napi::Function::New(env, GetPageCornerVisibility));
    exports.Set("getParentHierarchy", Napi::Function::New(env, GetParentHierarchy));
    exports.Set("getButtonStates", Napi::Function::New(env, GetButtonStates));
    exports.Set("getScrollAreaBounds", Napi::Function::New(env, GetScrollAreaBounds));
    return exports;
}

} // namespace

NODE_API_MODULE(word_accessibility, Init)
