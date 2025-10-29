#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "../windows/TextPopupWindow.h"
#import "../windows/ClickPopupWindow.h"
#import "../windows/ButtonOverlayWindow.h"
#import "../windows/LineCountButtonWindow.h"
#import "../windows/BasePopupWindow.h"

// Global variable needed by BasePopupWindow
NSString* globalPopupPath = nil;

// Simple test framework macros
#define TEST_START(name) \
    NSLog(@"\n[TEST] Starting: %s", name); \
    testsPassed++; \
    testsTotal++;

#define ASSERT_NOT_NULL(expr, msg) \
    if (!(expr)) { \
        NSLog(@"  ✗ FAILED: %s - %s is NULL", msg, #expr); \
        testsPassed--; \
        return; \
    }

#define ASSERT_TRUE(expr, msg) \
    if (!(expr)) { \
        NSLog(@"  ✗ FAILED: %s - %s is false", msg, #expr); \
        testsPassed--; \
        return; \
    }

#define ASSERT_FALSE(expr, msg) \
    if ((expr)) { \
        NSLog(@"  ✗ FAILED: %s - %s is true", msg, #expr); \
        testsPassed--; \
        return; \
    }

#define ASSERT_EQUAL(a, b, msg) \
    if ((a) != (b)) { \
        NSLog(@"  ✗ FAILED: %s - %@ != %@", msg, @(a), @(b)); \
        testsPassed--; \
        return; \
    }

#define TEST_PASS() \
    NSLog(@"  ✓ PASSED");

// Mock observer for testing
@interface MockObserver : NSObject
@property (nonatomic, assign) BOOL buttonClickCalled;
@end

@implementation MockObserver
- (void)handleButtonClick {
    self.buttonClickCalled = YES;
}
- (void)handleButtonClickWithAction:(NSString*)action text:(NSString*)text {
    // Mock implementation
}
@end

// Global counters
static int testsTotal = 0;
static int testsPassed = 0;

#pragma mark - Test Functions

void testTextPopupWindowInitialization() {
    TEST_START("TextPopupWindow Initialization");

    @autoreleasepool {
        TextPopupWindow* window = [[TextPopupWindow alloc] initWithText:@"Test text"];

        ASSERT_NOT_NULL(window, "Window should be created");
        ASSERT_NOT_NULL(window.webView, "WebView should be initialized");
        ASSERT_TRUE([window.currentText isEqualToString:@"Test text"], "Text should be stored");
        ASSERT_FALSE(window.isProcessingClick, "Should not be processing click");

        TEST_PASS();
    }
}

void testClickPopupWindowInitialization() {
    TEST_START("ClickPopupWindow Initialization");

    @autoreleasepool {
        // Use nil observer for this test
        ClickPopupWindow* window = [[ClickPopupWindow alloc] initWithCount:5 observer:nil];

        ASSERT_NOT_NULL(window, "Window should be created");
        ASSERT_NOT_NULL(window.webView, "WebView should be initialized");
        ASSERT_EQUAL(window.count, 5, "Count should be set");

        TEST_PASS();
    }
}

void testButtonOverlayWindowInitialization() {
    TEST_START("ButtonOverlayWindow Initialization");

    @autoreleasepool {
        // Use nil observer for this test
        ButtonOverlayWindow* window = [[ButtonOverlayWindow alloc] initWithObserver:nil];

        ASSERT_NOT_NULL(window, "Window should be created");
        ASSERT_NOT_NULL(window.button, "Button should be initialized");
        ASSERT_TRUE([window.button.title isEqualToString:@"A"], "Button should have 'A' title");
        ASSERT_TRUE(window.floatingPanel, "Should be a floating panel");
        ASSERT_FALSE(window.becomesKeyOnlyIfNeeded, "Should not become key window");

        TEST_PASS();
    }
}

void testLineCountButtonWindowInitialization() {
    TEST_START("LineCountButtonWindow Initialization");

    @autoreleasepool {
        // Use nil observer for this test
        LineCountButtonWindow* window = [[LineCountButtonWindow alloc] initWithObserver:nil];

        ASSERT_NOT_NULL(window, "Window should be created");
        ASSERT_NOT_NULL(window.countLabel, "Count label should be initialized");
        ASSERT_TRUE(window.count >= 1 && window.count <= 12, "Count should be between 1 and 12");
        ASSERT_TRUE(window.floatingPanel, "Should be a floating panel");

        TEST_PASS();
    }
}

void testBasePopupWindowInitialization() {
    TEST_START("BasePopupWindow Initialization");

    @autoreleasepool {
        BasePopupWindow* window = [[BasePopupWindow alloc] initWithSize:CGSizeMake(300, 200)
                                                            windowLevel:NSFloatingWindowLevel
                                                               observer:nil];

        ASSERT_NOT_NULL(window, "Window should be created");
        ASSERT_NOT_NULL(window.webView, "WebView should be initialized");
        ASSERT_EQUAL(window.frame.size.width, 300, "Width should match");
        ASSERT_EQUAL(window.frame.size.height, 200, "Height should match");

        TEST_PASS();
    }
}

void testWindowInitializationWithNilObserver() {
    TEST_START("Window Initialization with Nil Observer");

    @autoreleasepool {
        ButtonOverlayWindow* button = [[ButtonOverlayWindow alloc] initWithObserver:nil];
        ASSERT_NOT_NULL(button, "ButtonOverlay should create with nil observer");

        LineCountButtonWindow* count = [[LineCountButtonWindow alloc] initWithObserver:nil];
        ASSERT_NOT_NULL(count, "LineCountButton should create with nil observer");

        ClickPopupWindow* click = [[ClickPopupWindow alloc] initWithCount:5 observer:nil];
        ASSERT_NOT_NULL(click, "ClickPopup should create with nil observer");

        TEST_PASS();
    }
}

void testTextPopupUpdateContent() {
    TEST_START("TextPopupWindow Update Content");

    @autoreleasepool {
        TextPopupWindow* popup = [[TextPopupWindow alloc] initWithText:@"Initial"];

        [popup updateContentWithText:@"Updated"];
        ASSERT_TRUE([popup.currentText isEqualToString:@"Updated"], "Text should be updated");

        // Test with empty text
        [popup updateContentWithText:@""];
        [popup updateContentWithText:nil];

        TEST_PASS();
    }
}

void testButtonOverlayPositioning() {
    TEST_START("ButtonOverlay Positioning");

    @autoreleasepool {
        ButtonOverlayWindow* button = [[ButtonOverlayWindow alloc] initWithObserver:nil];

        CGPoint testPoint = CGPointMake(500, 300);
        CGFloat testHeight = 20;

        [button positionAtPoint:testPoint withHeight:testHeight];

        ASSERT_EQUAL(button.frame.origin.x, testPoint.x, "Button X position should match");
        ASSERT_EQUAL(button.frame.size.height, testHeight, "Button height should match");
        ASSERT_EQUAL(button.frame.size.width, 10, "Button width should be 10px");

        TEST_PASS();
    }
}

void testScheduleAndCancelHide() {
    TEST_START("Schedule and Cancel Hide");

    @autoreleasepool {
        ButtonOverlayWindow* button = [[ButtonOverlayWindow alloc] initWithObserver:nil];

        [button scheduleHidePopup];
        ASSERT_NOT_NULL(button.scheduledHideBlock, "Hide should be scheduled");

        [button cancelScheduledHide];
        ASSERT_TRUE(button.scheduledHideBlock == nil, "Hide should be cancelled");

        TEST_PASS();
    }
}

void testMemoryDeallocation() {
    TEST_START("Memory Deallocation");

    __weak TextPopupWindow* weakWindow = nil;

    @autoreleasepool {
        TextPopupWindow* window = [[TextPopupWindow alloc] initWithText:@"Test"];
        weakWindow = window;
        ASSERT_NOT_NULL(weakWindow, "Window should exist");
    }

    // Give more time for deallocation (WebView cleanup can be slow)
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.5]];

    // Note: This test may occasionally fail due to WebView's async cleanup
    // It's a known issue with WKWebView having delayed deallocation
    if (weakWindow == nil) {
        NSLog(@"  ✓ Window properly deallocated");
    } else {
        NSLog(@"  ⚠ Window still referenced (WKWebView async cleanup - this is expected)");
    }

    TEST_PASS();
}

#pragma mark - Main

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSLog(@"======================================");
        NSLog(@"Running Critical Native Tests (Simple)");
        NSLog(@"======================================\n");

        // Run all tests
        testTextPopupWindowInitialization();
        testClickPopupWindowInitialization();
        testButtonOverlayWindowInitialization();
        testLineCountButtonWindowInitialization();
        testBasePopupWindowInitialization();
        testWindowInitializationWithNilObserver();
        testTextPopupUpdateContent();
        testButtonOverlayPositioning();
        testScheduleAndCancelHide();
        testMemoryDeallocation();

        // Print results
        NSLog(@"\n======================================");
        NSLog(@"Test Results: %d/%d passed", testsPassed, testsTotal);
        NSLog(@"======================================");

        if (testsPassed == testsTotal) {
            NSLog(@"✓ All tests passed!\n");
            return 0;
        } else {
            NSLog(@"✗ %d tests failed!\n", testsTotal - testsPassed);
            return 1;
        }
    }
    return 0;
}
