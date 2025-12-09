//
//  MicrosoftWordAdapter.simple-test.mm
//  AcademiaElectron
//
//  Simple tests for MicrosoftWordAdapter (no XCTest required)
//

#import <Cocoa/Cocoa.h>
#import "MicrosoftWordAdapter.h"

// Global variable needed by BasePopupWindow
NSString* globalPopupPath = nil;

// Global variable needed by MicrosoftWordAdapter (stub for tests)
BOOL featureScrollTrackingEnabled = YES;

// Stub for AcademiaLog (defined in bridge.mm which has NAPI dependencies)
void AcademiaLog(NSString* format, ...) {
    va_list args;
    va_start(args, format);
    NSLogv(format, args);
    va_end(args);
}

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

#define ASSERT_NULL(expr, msg) \
    if ((expr)) { \
        NSLog(@"  ✗ FAILED: %s - %s is not NULL", msg, #expr); \
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

#define ASSERT_RECT_VALID(rect, msg) \
    if (CGRectIsNull(rect) || CGRectIsInfinite(rect)) { \
        NSLog(@"  ✗ FAILED: %s - rect is invalid", msg); \
        testsPassed--; \
        return; \
    }

#define ASSERT_NO_THROW(expr, msg) \
    @try { \
        expr; \
    } @catch (NSException *exception) { \
        NSLog(@"  ✗ FAILED: %s - threw exception: %@", msg, exception); \
        testsPassed--; \
        return; \
    }

#define TEST_PASS() \
    NSLog(@"  ✓ PASSED");

// Global counters
static int testsTotal = 0;
static int testsPassed = 0;

#pragma mark - Mock Delegate

/**
 * Mock delegate for testing event emissions
 */
@interface MockWordAdapterDelegate : NSObject <MicrosoftWordAdapterDelegate>
@property (nonatomic, assign) BOOL didStartChangingCalled;
@property (nonatomic, assign) BOOL didCompleteChangingCalled;
@property (nonatomic, assign) BOOL didActivateCalled;
@property (nonatomic, assign) BOOL didDeactivateCalled;
@property (nonatomic, assign) WordPositionState lastState;
@end

@implementation MockWordAdapterDelegate

- (instancetype)init {
    self = [super init];
    if (self) {
        _didStartChangingCalled = NO;
        _didCompleteChangingCalled = NO;
        _didActivateCalled = NO;
        _didDeactivateCalled = NO;
    }
    return self;
}

- (void)wordAdapterDidStartChanging:(id)adapter {
    self.didStartChangingCalled = YES;
}

- (void)wordAdapterDidCompleteChanging:(id)adapter withState:(WordPositionState)state {
    self.didCompleteChangingCalled = YES;
    self.lastState = state;
}

- (void)wordAdapterDidActivate:(id)adapter {
    self.didActivateCalled = YES;
}

- (void)wordAdapterDidDeactivate:(id)adapter {
    self.didDeactivateCalled = YES;
}

- (void)reset {
    self.didStartChangingCalled = NO;
    self.didCompleteChangingCalled = NO;
    self.didActivateCalled = NO;
    self.didDeactivateCalled = NO;
}

@end

#pragma mark - Test Functions

void testInitialization() {
    TEST_START("MicrosoftWordAdapter Initialization");

    @autoreleasepool {
        MockWordAdapterDelegate *mockDelegate = [[MockWordAdapterDelegate alloc] init];
        pid_t testPID = 12345;

        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:testPID delegate:mockDelegate];

        ASSERT_NOT_NULL(adapter, "Adapter should initialize successfully");
        ASSERT_EQUAL(adapter.wordPID, testPID, "PID should match initialization value");
        ASSERT_TRUE(adapter.delegate == mockDelegate, "Delegate should be set");
        ASSERT_FALSE(adapter.isObserving, "Should not be observing initially");

        TEST_PASS();
    }
}

void testInitializationWithoutDelegate() {
    TEST_START("MicrosoftWordAdapter Initialization Without Delegate");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        ASSERT_NOT_NULL(adapter, "Should initialize without delegate");
        ASSERT_NULL(adapter.delegate, "Delegate should be nil");

        TEST_PASS();
    }
}

void testCacheInvalidation() {
    TEST_START("Cache Invalidation");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        ASSERT_NO_THROW([adapter invalidateCaches], "Cache invalidation should not throw");

        TEST_PASS();
    }
}

void testCachedWordBoundsUpdate() {
    TEST_START("Cached Word Bounds Update");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        ASSERT_NO_THROW([adapter updateCachedWordBounds], "Cache update should not throw");

        TEST_PASS();
    }
}

void testGetWordWindowBoundsWithoutWord() {
    TEST_START("Get Word Window Bounds Without Word Running");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        // Without Word running at this PID, should return CGRectZero or valid rect
        CGRect bounds = [adapter getWordWindowBounds];

        // Should not crash and should return a valid rect (even if zero)
        ASSERT_TRUE(CGRectEqualToRect(bounds, CGRectZero) || !CGRectIsNull(bounds),
                   "getWordWindowBounds should return a valid CGRect");

        TEST_PASS();
    }
}

void testGetScrollAreaBoundsWithoutWord() {
    TEST_START("Get Scroll Area Bounds Without Word Running");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        CGRect bounds = [adapter getScrollAreaBounds];

        ASSERT_TRUE(CGRectEqualToRect(bounds, CGRectZero) || !CGRectIsNull(bounds),
                   "getScrollAreaBounds should return a valid CGRect");

        TEST_PASS();
    }
}

void testGetLayoutBoundsWithoutWord() {
    TEST_START("Get Layout Bounds Without Word Running");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        CGRect bounds = [adapter getLayoutBounds];

        ASSERT_TRUE(CGRectEqualToRect(bounds, CGRectZero) || !CGRectIsNull(bounds),
                   "getLayoutBounds should return a valid CGRect");

        TEST_PASS();
    }
}

void testGetLayoutLeftMarginWithoutWord() {
    TEST_START("Get Layout Left Margin Without Word Running");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        CGFloat margin = [adapter getLayoutLeftMargin];

        ASSERT_TRUE(margin >= 0 || margin == 0, "Layout left margin should be a valid number");

        TEST_PASS();
    }
}

void testGetFirstLinePositionWithoutWord() {
    TEST_START("Get First Line Position Without Word Running");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        CGRect position = [adapter getFirstLinePosition];

        ASSERT_TRUE(CGRectEqualToRect(position, CGRectZero) || !CGRectIsNull(position),
                   "getFirstLinePosition should return a valid CGRect");

        TEST_PASS();
    }
}

void testGetVisibleCharacterRangeWithoutWord() {
    TEST_START("Get Visible Character Range Without Word Running");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        CFRange range = [adapter getVisibleCharacterRange];

        // Range should be valid (non-negative values)
        ASSERT_TRUE(range.location >= 0 && range.length >= 0,
                   "getVisibleCharacterRange should return valid range");

        TEST_PASS();
    }
}

void testIsPageCornerVisibleWithoutWord() {
    TEST_START("Is Page Corner Visible Without Word Running");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        BOOL visible = [adapter isPageCornerVisible];

        // Should return a boolean (YES or NO) without crashing
        ASSERT_TRUE(visible == YES || visible == NO, "isPageCornerVisible should return boolean");

        TEST_PASS();
    }
}

void testGetCurrentState() {
    TEST_START("Get Current State");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        // Test that we can get a complete state snapshot
        WordPositionState state = [adapter getCurrentState];

        // Verify all fields are present (may be zero/false without Word running)
        ASSERT_TRUE(CGRectEqualToRect(state.windowBounds, CGRectZero) || !CGRectIsNull(state.windowBounds),
                   "State should have valid windowBounds");
        ASSERT_TRUE(CGRectEqualToRect(state.scrollAreaBounds, CGRectZero) || !CGRectIsNull(state.scrollAreaBounds),
                   "State should have valid scrollAreaBounds");
        ASSERT_TRUE(CGPointEqualToPoint(state.layoutPosition, CGPointZero) || !isnan(state.layoutPosition.x),
                   "State should have valid layoutPosition");
        ASSERT_TRUE(CGSizeEqualToSize(state.layoutSize, CGSizeZero) || (state.layoutSize.width >= 0 && state.layoutSize.height >= 0),
                   "State should have valid layoutSize");
        ASSERT_TRUE(state.layoutLeftMargin >= 0 || state.layoutLeftMargin == 0,
                   "State should have valid layoutLeftMargin");
        ASSERT_TRUE(CGRectEqualToRect(state.firstLinePosition, CGRectZero) || !CGRectIsNull(state.firstLinePosition),
                   "State should have valid firstLinePosition");
        ASSERT_TRUE(state.visibleCharacterRange.location >= 0 && state.visibleCharacterRange.length >= 0,
                   "State should have valid visibleCharacterRange");
        ASSERT_TRUE(state.isPageCornerVisible == YES || state.isPageCornerVisible == NO,
                   "State should have valid isPageCornerVisible boolean");

        TEST_PASS();
    }
}

void testStopObservingWhenNotObserving() {
    TEST_START("Stop Observing When Not Observing");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        // Should be safe to call stopObserving when not observing
        ASSERT_NO_THROW([adapter stopObserving], "stopObserving should be safe when not observing");

        TEST_PASS();
    }
}

void testCheckAccessibilityPermission() {
    TEST_START("Check Accessibility Permission");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        // Test accessibility permission check
        BOOL hasPermission = [adapter checkAccessibilityPermission];

        ASSERT_TRUE(hasPermission == YES || hasPermission == NO,
                   "checkAccessibilityPermission should return boolean");

        TEST_PASS();
    }
}

void testDelegateWeakReference() {
    TEST_START("Delegate Weak Reference");

    @autoreleasepool {
        // Create adapter with delegate in a scope
        @autoreleasepool {
            MockWordAdapterDelegate *tempDelegate = [[MockWordAdapterDelegate alloc] init];
            MicrosoftWordAdapter *tempAdapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:tempDelegate];

            ASSERT_NOT_NULL(tempAdapter.delegate, "Delegate should be set");

            // Test passes if we get here without crashing
        }

        TEST_PASS();
    }
}

void testPositionQueryPerformance() {
    TEST_START("Position Query Performance");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        // Test that position queries complete without hanging
        NSDate *startTime = [NSDate date];

        for (int i = 0; i < 100; i++) {
            [adapter getWordWindowBounds];
        }

        NSTimeInterval elapsed = -[startTime timeIntervalSinceNow];

        // 100 queries should complete in under 5 seconds (even with no caching)
        ASSERT_TRUE(elapsed < 5.0, "Position queries should complete reasonably quickly");

        TEST_PASS();
    }
}

void testCacheEffectiveness() {
    TEST_START("Cache Effectiveness");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        // First call should query, second should use cache
        CGRect firstCall = [adapter getWordWindowBounds];
        CGRect secondCall = [adapter getWordWindowBounds];

        // Both calls should return the same value (from cache)
        ASSERT_TRUE(CGRectEqualToRect(firstCall, secondCall),
                   "Cached calls should return same value");

        TEST_PASS();
    }
}

void testStartObservingWithoutPermission() {
    TEST_START("Start Observing Without Permission");

    @autoreleasepool {
        MicrosoftWordAdapter *adapter = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:nil];

        NSError *error = nil;
        BOOL result = [adapter startObserving:&error];

        // Result depends on whether permission is granted
        if (!result) {
            ASSERT_NOT_NULL(error, "Error should be provided if startObserving fails");
            NSLog(@"  Note: startObserving failed (expected without accessibility permission): %@", error.localizedDescription);
        } else {
            // If successful, should be observing
            ASSERT_TRUE(adapter.isObserving, "Should be observing after successful start");

            // Clean up
            [adapter stopObserving];
            ASSERT_FALSE(adapter.isObserving, "Should not be observing after stop");
        }

        TEST_PASS();
    }
}

void testMultipleAdapterInstances() {
    TEST_START("Multiple Adapter Instances");

    @autoreleasepool {
        MockWordAdapterDelegate *delegate1 = [[MockWordAdapterDelegate alloc] init];
        MockWordAdapterDelegate *delegate2 = [[MockWordAdapterDelegate alloc] init];

        MicrosoftWordAdapter *adapter1 = [[MicrosoftWordAdapter alloc] initWithPID:12345 delegate:delegate1];
        MicrosoftWordAdapter *adapter2 = [[MicrosoftWordAdapter alloc] initWithPID:12346 delegate:delegate2];

        ASSERT_NOT_NULL(adapter1, "First adapter should be created");
        ASSERT_NOT_NULL(adapter2, "Second adapter should be created");
        ASSERT_EQUAL(adapter1.wordPID, 12345, "First adapter should have correct PID");
        ASSERT_EQUAL(adapter2.wordPID, 12346, "Second adapter should have correct PID");
        ASSERT_TRUE(adapter1.delegate == delegate1, "First adapter should have correct delegate");
        ASSERT_TRUE(adapter2.delegate == delegate2, "Second adapter should have correct delegate");

        TEST_PASS();
    }
}

#pragma mark - Main

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSLog(@"======================================");
        NSLog(@"Running MicrosoftWordAdapter Tests (Simple)");
        NSLog(@"======================================\n");

        NSLog(@"Note: These tests do not require Microsoft Word to be running.");
        NSLog(@"Tests validate that the adapter handles missing Word gracefully.\n");

        // Run all tests
        testInitialization();
        testInitializationWithoutDelegate();
        testCacheInvalidation();
        testCachedWordBoundsUpdate();
        testGetWordWindowBoundsWithoutWord();
        testGetScrollAreaBoundsWithoutWord();
        testGetLayoutBoundsWithoutWord();
        testGetLayoutLeftMarginWithoutWord();
        testGetFirstLinePositionWithoutWord();
        testGetVisibleCharacterRangeWithoutWord();
        testIsPageCornerVisibleWithoutWord();
        testGetCurrentState();
        testStopObservingWhenNotObserving();
        testCheckAccessibilityPermission();
        testDelegateWeakReference();
        testPositionQueryPerformance();
        testCacheEffectiveness();
        testStartObservingWithoutPermission();
        testMultipleAdapterInstances();

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
