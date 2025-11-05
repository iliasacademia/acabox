//
//  AcademiaManager.simple-test.mm
//  AcademiaElectron
//
//  Simple tests for AcademiaManager (no XCTest required)
//

#import <Cocoa/Cocoa.h>
#import "AcademiaManager.h"
#import "../adapters/MicrosoftWordAdapter.h"

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

#pragma mark - Mock Overlay Window

/**
 * Mock overlay window for testing
 */
@interface MockOverlayWindow : NSObject <OverlayWindow>
@property (nonatomic, assign) BOOL hideCalled;
@property (nonatomic, assign) BOOL showCalled;
@property (nonatomic, assign) BOOL updatePositionCalled;
@property (nonatomic, assign) BOOL updateBadgeCalled;
@property (nonatomic, assign) WordPositionState lastReceivedState;
@property (nonatomic, assign) NSInteger lastBadgeCount;
@property (nonatomic, assign) BOOL isCurrentlyVisible;
@property (nonatomic, strong) NSString *identifier;
@end

@implementation MockOverlayWindow

- (instancetype)initWithIdentifier:(NSString *)identifier {
    self = [super init];
    if (self) {
        _identifier = identifier;
        _isCurrentlyVisible = NO;
        _hideCalled = NO;
        _showCalled = NO;
        _updatePositionCalled = NO;
        _updateBadgeCalled = NO;
        _lastBadgeCount = -1;
    }
    return self;
}

- (void)updatePositionWithWordState:(WordPositionState)state {
    self.updatePositionCalled = YES;
    self.lastReceivedState = state;
}

- (void)hide {
    self.hideCalled = YES;
    self.isCurrentlyVisible = NO;
}

- (void)show {
    self.showCalled = YES;
    self.isCurrentlyVisible = YES;
}

- (BOOL)isVisible {
    return self.isCurrentlyVisible;
}

- (void)updateBadgeCount:(NSInteger)count {
    self.updateBadgeCalled = YES;
    self.lastBadgeCount = count;
}

- (NSString *)overlayIdentifier {
    return self.identifier;
}

- (void)reset {
    self.hideCalled = NO;
    self.showCalled = NO;
    self.updatePositionCalled = NO;
    self.updateBadgeCalled = NO;
}

@end

#pragma mark - Mock Word Adapter

/**
 * Mock Word adapter for testing
 */
@interface MockWordAdapter : NSObject
@property (nonatomic, weak) id<MicrosoftWordAdapterDelegate> delegate;
@property (nonatomic, assign) BOOL observing;
@property (nonatomic, assign) pid_t wordPID;
@property (nonatomic, assign) BOOL isObserving;
@end

@implementation MockWordAdapter

- (instancetype)init {
    self = [super init];
    if (self) {
        _observing = NO;
        _isObserving = NO;
        _wordPID = 12345;  // Dummy PID for testing
    }
    return self;
}

- (BOOL)startObserving:(NSError **)error {
    self.observing = YES;
    self.isObserving = YES;
    return YES;
}

- (void)stopObserving {
    self.observing = NO;
    self.isObserving = NO;
}

- (WordPositionState)getCurrentState {
    WordPositionState state = {0};
    state.windowBounds = CGRectMake(0, 0, 800, 600);
    state.scrollAreaBounds = CGRectMake(0, 0, 800, 600);
    state.layoutPosition = CGPointZero;
    state.layoutSize = CGSizeMake(800, 600);
    state.layoutLeftMargin = 0;
    state.firstLinePosition = CGRectZero;
    state.visibleCharacterRange = CFRangeMake(0, 0);
    state.isPageCornerVisible = NO;
    return state;
}

// Simulate adapter events
- (void)simulateChangeStart {
    if ([self.delegate respondsToSelector:@selector(wordAdapterDidStartChanging:)]) {
        [self.delegate wordAdapterDidStartChanging:self];
    }
}

- (void)simulateChangeComplete:(WordPositionState)state {
    if ([self.delegate respondsToSelector:@selector(wordAdapterDidCompleteChanging:withState:)]) {
        [self.delegate wordAdapterDidCompleteChanging:self withState:state];
    }
}

@end

#pragma mark - Test Functions

void testInitialization() {
    TEST_START("AcademiaManager Initialization");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];

        ASSERT_NOT_NULL(manager, "Manager should be initialized");
        ASSERT_FALSE(manager.isManaging, "Manager should not be managing initially");

        TEST_PASS();
    }
}

void testStartManaging() {
    TEST_START("Start Managing");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        BOOL started = [manager startManaging];

        ASSERT_TRUE(started, "Should successfully start managing");
        ASSERT_TRUE(manager.isManaging, "Manager should be in managing state");
        ASSERT_TRUE(mockAdapter.observing, "Adapter should be observing");

        TEST_PASS();
    }
}

void testStopManaging() {
    TEST_START("Stop Managing");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        [manager startManaging];
        [manager stopManaging];

        ASSERT_FALSE(manager.isManaging, "Manager should not be managing after stop");
        // Note: AcademiaManager doesn't stop the adapter, it only removes itself as delegate
        ASSERT_TRUE(mockAdapter.delegate == nil, "Delegate should be removed");

        TEST_PASS();
    }
}

void testRegisterOverlay() {
    TEST_START("Register Overlay");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay = [[MockOverlayWindow alloc] initWithIdentifier:@"TestOverlay"];
        [manager registerOverlay:overlay];

        ASSERT_NOT_NULL(overlay, "Overlay should remain valid after registration");
        ASSERT_EQUAL(manager.registeredOverlayCount, 1, "Should have one registered overlay");

        TEST_PASS();
    }
}

void testRegisterMultipleOverlays() {
    TEST_START("Register Multiple Overlays");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay1 = [[MockOverlayWindow alloc] initWithIdentifier:@"NotificationsButton"];
        MockOverlayWindow *overlay2 = [[MockOverlayWindow alloc] initWithIdentifier:@"OverallReviewButton"];
        MockOverlayWindow *overlay3 = [[MockOverlayWindow alloc] initWithIdentifier:@"OverallReviewPopup"];

        [manager registerOverlay:overlay1];
        [manager registerOverlay:overlay2];
        [manager registerOverlay:overlay3];

        ASSERT_NOT_NULL(overlay1, "Overlay 1 should remain valid");
        ASSERT_NOT_NULL(overlay2, "Overlay 2 should remain valid");
        ASSERT_NOT_NULL(overlay3, "Overlay 3 should remain valid");
        ASSERT_EQUAL(manager.registeredOverlayCount, 3, "Should have three registered overlays");

        TEST_PASS();
    }
}

void testUnregisterOverlay() {
    TEST_START("Unregister Overlay");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay = [[MockOverlayWindow alloc] initWithIdentifier:@"TestOverlay"];
        [manager registerOverlay:overlay];
        [manager unregisterOverlay:overlay];

        ASSERT_EQUAL(manager.registeredOverlayCount, 0, "Should have no registered overlays");

        // After unregistering, overlay should not receive events
        [manager startManaging];

        WordPositionState testState = {0};
        [mockAdapter simulateChangeComplete:testState];

        ASSERT_FALSE(overlay.updatePositionCalled, "Unregistered overlay should not receive events");

        TEST_PASS();
    }
}

void testChangeStartHidesAllOverlays() {
    TEST_START("Change Start Hides All Overlays");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay1 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay1"];
        MockOverlayWindow *overlay2 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay2"];
        MockOverlayWindow *overlay3 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay3"];

        // Mark overlays as visible
        overlay1.isCurrentlyVisible = YES;
        overlay2.isCurrentlyVisible = YES;
        overlay3.isCurrentlyVisible = YES;

        [manager registerOverlay:overlay1];
        [manager registerOverlay:overlay2];
        [manager registerOverlay:overlay3];

        [manager startManaging];

        [mockAdapter simulateChangeStart];

        ASSERT_TRUE(overlay1.hideCalled, "Overlay 1 should be hidden on change start");
        ASSERT_TRUE(overlay2.hideCalled, "Overlay 2 should be hidden on change start");
        ASSERT_TRUE(overlay3.hideCalled, "Overlay 3 should be hidden on change start");

        TEST_PASS();
    }
}

void testChangeCompleteUpdatesAndShowsOverlays() {
    TEST_START("Change Complete Updates and Shows Overlays");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay1 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay1"];
        MockOverlayWindow *overlay2 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay2"];

        [manager registerOverlay:overlay1];
        [manager registerOverlay:overlay2];

        [manager startManaging];

        WordPositionState testState;
        testState.windowBounds = CGRectMake(100, 100, 800, 600);
        testState.scrollAreaBounds = CGRectMake(100, 150, 800, 550);
        testState.layoutPosition = CGPointMake(120, 170);
        testState.layoutSize = CGSizeMake(800, 550);
        testState.layoutLeftMargin = 120;
        testState.firstLinePosition = CGRectMake(120, 170, 400, 20);
        testState.visibleCharacterRange = CFRangeMake(0, 100);
        testState.isPageCornerVisible = YES;

        [mockAdapter simulateChangeComplete:testState];

        ASSERT_TRUE(overlay1.updatePositionCalled, "Overlay 1 should receive position update");
        ASSERT_TRUE(overlay2.updatePositionCalled, "Overlay 2 should receive position update");
        ASSERT_EQUAL(overlay1.lastReceivedState.windowBounds.origin.x, 100.0, "State should be passed correctly");
        ASSERT_TRUE(overlay1.showCalled, "Overlay 1 should be shown after update");
        ASSERT_TRUE(overlay2.showCalled, "Overlay 2 should be shown after update");

        TEST_PASS();
    }
}

void testChangeLifecycle() {
    TEST_START("Change Lifecycle");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay = [[MockOverlayWindow alloc] initWithIdentifier:@"TestOverlay"];
        overlay.isCurrentlyVisible = YES; // Mark as visible

        [manager registerOverlay:overlay];

        [manager startManaging];

        [mockAdapter simulateChangeStart];
        ASSERT_TRUE(overlay.hideCalled, "Overlay should be hidden on change start");

        [overlay reset];

        WordPositionState testState = {0};
        testState.windowBounds = CGRectMake(0, 0, 800, 600);
        [mockAdapter simulateChangeComplete:testState];

        ASSERT_TRUE(overlay.updatePositionCalled, "Overlay should receive position update");
        ASSERT_TRUE(overlay.showCalled, "Overlay should be shown after change complete");

        TEST_PASS();
    }
}

void testUpdateBadgeCount() {
    TEST_START("Update Badge Count");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay1 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay1"];
        MockOverlayWindow *overlay2 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay2"];

        [manager registerOverlay:overlay1];
        [manager registerOverlay:overlay2];

        [manager updateBadgeCount:5];

        ASSERT_TRUE(overlay1.updateBadgeCalled, "Overlay 1 should receive badge update");
        ASSERT_EQUAL(overlay1.lastBadgeCount, 5, "Overlay 1 should receive correct count");
        ASSERT_TRUE(overlay2.updateBadgeCalled, "Overlay 2 should receive badge update");
        ASSERT_EQUAL(overlay2.lastBadgeCount, 5, "Overlay 2 should receive correct count");

        TEST_PASS();
    }
}

void testUpdateBadgeCountWithZero() {
    TEST_START("Update Badge Count With Zero");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay = [[MockOverlayWindow alloc] initWithIdentifier:@"TestOverlay"];
        [manager registerOverlay:overlay];

        [manager updateBadgeCount:0];

        ASSERT_TRUE(overlay.updateBadgeCalled, "Overlay should receive badge update");
        ASSERT_EQUAL(overlay.lastBadgeCount, 0, "Badge count should be 0");

        TEST_PASS();
    }
}

void testRegisterNilOverlay() {
    TEST_START("Register Nil Overlay");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        ASSERT_NO_THROW([manager registerOverlay:nil], "Should handle nil overlay gracefully");
        ASSERT_EQUAL(manager.registeredOverlayCount, 0, "Should not register nil overlay");

        TEST_PASS();
    }
}

void testUnregisterNilOverlay() {
    TEST_START("Unregister Nil Overlay");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        ASSERT_NO_THROW([manager unregisterOverlay:nil], "Should handle nil overlay gracefully");

        TEST_PASS();
    }
}

void testUnregisterNonRegisteredOverlay() {
    TEST_START("Unregister Non-Registered Overlay");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *unregistered = [[MockOverlayWindow alloc] initWithIdentifier:@"Unregistered"];

        ASSERT_NO_THROW([manager unregisterOverlay:unregistered], "Should handle unregistered overlay gracefully");

        TEST_PASS();
    }
}

void testMultipleRegistrationsSameOverlay() {
    TEST_START("Multiple Registrations Same Overlay");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay = [[MockOverlayWindow alloc] initWithIdentifier:@"TestOverlay"];
        overlay.isCurrentlyVisible = YES; // Mark as visible

        [manager registerOverlay:overlay];
        [manager registerOverlay:overlay];

        [manager startManaging];
        [mockAdapter simulateChangeStart];

        ASSERT_TRUE(overlay.hideCalled, "Overlay should be hidden");

        TEST_PASS();
    }
}

void testEventsBeforeStartManaging() {
    TEST_START("Events Before Start Managing");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay = [[MockOverlayWindow alloc] initWithIdentifier:@"TestOverlay"];
        [manager registerOverlay:overlay];

        [mockAdapter simulateChangeStart];
        WordPositionState testState = {0};
        [mockAdapter simulateChangeComplete:testState];

        // Test should complete without crash
        ASSERT_TRUE(YES, "Test should complete without crash");

        TEST_PASS();
    }
}

void testWeakReferences() {
    TEST_START("Weak References");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        @autoreleasepool {
            MockOverlayWindow *tempOverlay = [[MockOverlayWindow alloc] initWithIdentifier:@"Temp"];
            [manager registerOverlay:tempOverlay];

            ASSERT_NOT_NULL(tempOverlay, "Overlay should be alive");
        }

        [manager startManaging];

        // Simulate change - should not crash even with deallocated overlay
        ASSERT_NO_THROW([mockAdapter simulateChangeStart], "Should handle deallocated overlays gracefully");

        TEST_PASS();
    }
}

void testPerformanceManyOverlays() {
    TEST_START("Performance Many Overlays");

    // Keep overlays and adapter alive outside autorelease pool
    MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
    AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
    mockAdapter.delegate = manager;

    NSMutableArray<MockOverlayWindow *> *overlays = [NSMutableArray array];
    for (int i = 0; i < 100; i++) {
        MockOverlayWindow *overlay = [[MockOverlayWindow alloc]
            initWithIdentifier:[NSString stringWithFormat:@"Overlay%d", i]];
        overlay.isCurrentlyVisible = YES; // Mark as visible
        [overlays addObject:overlay];
        [manager registerOverlay:overlay];
    }

    [manager startManaging];

    NSDate *startTime = [NSDate date];
    [mockAdapter simulateChangeStart];
    NSTimeInterval elapsed = -[startTime timeIntervalSinceNow];

    // Should complete in under 1 second
    ASSERT_TRUE(elapsed < 1.0, "Should hide 100 overlays quickly");

    // Verify all were hidden
    for (MockOverlayWindow *overlay in overlays) {
        if (!overlay.hideCalled) {
            NSLog(@"  ✗ FAILED: Not all overlays were hidden");
            testsPassed--;
            return;
        }
    }

    TEST_PASS();
}

void testHideAllOverlays() {
    TEST_START("Hide All Overlays");

    // Keep overlays alive outside autorelease pool
    MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
    AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
    mockAdapter.delegate = manager;

    MockOverlayWindow *overlay1 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay1"];
    MockOverlayWindow *overlay2 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay2"];

    // Mark overlays as visible
    overlay1.isCurrentlyVisible = YES;
    overlay2.isCurrentlyVisible = YES;

    [manager registerOverlay:overlay1];
    [manager registerOverlay:overlay2];

    [manager hideAllOverlays];

    ASSERT_TRUE(overlay1.hideCalled, "Overlay 1 should be hidden");
    ASSERT_TRUE(overlay2.hideCalled, "Overlay 2 should be hidden");

    TEST_PASS();
}

void testShowAllOverlays() {
    TEST_START("Show All Overlays");

    // Keep overlays alive outside autorelease pool
    MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
    AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
    mockAdapter.delegate = manager;

    MockOverlayWindow *overlay1 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay1"];
    MockOverlayWindow *overlay2 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay2"];

    [manager registerOverlay:overlay1];
    [manager registerOverlay:overlay2];

    // Need to start managing first
    [manager startManaging];

    [manager showAllOverlays];

    ASSERT_TRUE(overlay1.updatePositionCalled, "Overlay 1 should receive position update");
    ASSERT_TRUE(overlay1.showCalled, "Overlay 1 should be shown");
    ASSERT_TRUE(overlay2.updatePositionCalled, "Overlay 2 should receive position update");
    ASSERT_TRUE(overlay2.showCalled, "Overlay 2 should be shown");

    TEST_PASS();
}

void testHasVisibleOverlays() {
    TEST_START("Has Visible Overlays");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay = [[MockOverlayWindow alloc] initWithIdentifier:@"TestOverlay"];
        [manager registerOverlay:overlay];

        ASSERT_FALSE([manager hasVisibleOverlays], "Should have no visible overlays initially");

        overlay.isCurrentlyVisible = YES;
        ASSERT_TRUE([manager hasVisibleOverlays], "Should have visible overlays");

        TEST_PASS();
    }
}

void testUnregisterAllOverlays() {
    TEST_START("Unregister All Overlays");

    @autoreleasepool {
        MockWordAdapter *mockAdapter = [[MockWordAdapter alloc] init];
        AcademiaManager *manager = [[AcademiaManager alloc] initWithWordAdapter:(MicrosoftWordAdapter *)mockAdapter];
        mockAdapter.delegate = manager;

        MockOverlayWindow *overlay1 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay1"];
        MockOverlayWindow *overlay2 = [[MockOverlayWindow alloc] initWithIdentifier:@"Overlay2"];

        [manager registerOverlay:overlay1];
        [manager registerOverlay:overlay2];

        ASSERT_EQUAL(manager.registeredOverlayCount, 2, "Should have 2 registered overlays");

        [manager unregisterAllOverlays];

        ASSERT_EQUAL(manager.registeredOverlayCount, 0, "Should have no registered overlays");

        TEST_PASS();
    }
}

#pragma mark - Main

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSLog(@"======================================");
        NSLog(@"Running AcademiaManager Tests (Simple)");
        NSLog(@"======================================\n");

        NSLog(@"Note: These tests use mock adapters and overlays.");
        NSLog(@"Tests validate coordination logic without requiring Word.\n");

        // Run all tests
        testInitialization();
        testStartManaging();
        testStopManaging();
        testRegisterOverlay();
        testRegisterMultipleOverlays();
        testUnregisterOverlay();
        testChangeStartHidesAllOverlays();
        testChangeCompleteUpdatesAndShowsOverlays();
        testChangeLifecycle();
        testUpdateBadgeCount();
        testUpdateBadgeCountWithZero();
        testRegisterNilOverlay();
        testUnregisterNilOverlay();
        testUnregisterNonRegisteredOverlay();
        testMultipleRegistrationsSameOverlay();
        testEventsBeforeStartManaging();
        testWeakReferences();
        testPerformanceManyOverlays();
        testHideAllOverlays();
        testShowAllOverlays();
        testHasVisibleOverlays();
        testUnregisterAllOverlays();

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
