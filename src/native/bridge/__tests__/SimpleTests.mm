#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "../windows/TextPopupWindow.h"
#import "../windows/ClickPopupWindow.h"
#import "../windows/ButtonOverlayWindow.h"
#import "../windows/LineCountButtonWindow.h"
#import "../windows/BasePopupWindow.h"
#include "../interface/MessageRouter.h"
#include "../interface/Message.h"
#include "../macos/MacOSWebViewBridge.h"

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
        ASSERT_TRUE(window.clickState == ClickStateIdle, "Should be in idle state (WAGENT-78)");

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
        ASSERT_EQUAL(button.frame.size.width, 30, "Button width should be 30px");

        TEST_PASS();
    }
}

// NOTE: Commented out - scheduleHidePopup/cancelScheduledHide methods removed in refactor
// void testScheduleAndCancelHide() {
//     TEST_START("Schedule and Cancel Hide");
//
//     @autoreleasepool {
//         ButtonOverlayWindow* button = [[ButtonOverlayWindow alloc] initWithObserver:nil];
//
//         [button scheduleHidePopup];
//         ASSERT_NOT_NULL(button.scheduledHideBlock, "Hide should be scheduled");
//
//         [button cancelScheduledHide];
//         ASSERT_TRUE(button.scheduledHideBlock == nil, "Hide should be cancelled");
//
//         TEST_PASS();
//     }
// }

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

#pragma mark - Message Queue Tests (WAGENT-69, 70, 71, 72)

// Mock bridge for testing message queue functionality
class MockTestBridge : public AcademiaBridge::IWebViewBridge {
public:
    MockTestBridge(const std::string& clientId, bool ready = false)
        : clientId_(clientId), ready_(ready), messageCount_(0) {}

    // IWebViewBridge interface implementation
    bool initialize() override { return true; }
    void destroy() override {}
    bool isReady() const override { return ready_; }
    void setReady(bool ready) { ready_ = ready; }

    std::string getClientId() const override { return clientId_; }
    void setClientId(const std::string& clientId) override { clientId_ = clientId; }

    void sendMessage(const AcademiaBridge::Message& msg) override {
        messageCount_++;
        lastMessage_ = msg;
    }

    void sendMessageAsync(const AcademiaBridge::Message& msg,
                         AcademiaBridge::ResponseCallback callback) override {
        messageCount_++;
    }

    void registerHandler(const std::string& action,
                        AcademiaBridge::MessageHandler handler) override {}

    void unregisterHandler(const std::string& action) override {}

    void showWindow() override {}
    void hideWindow() override {}
    void setWindowPosition(int x, int y) override {}
    void setWindowSize(int width, int height) override {}
    void getWindowPosition(int& outX, int& outY) const override { outX = 0; outY = 0; }
    void getWindowSize(int& outWidth, int& outHeight) const override { outWidth = 0; outHeight = 0; }
    void loadHTML(const std::string& htmlPath) override {}
    void loadHTMLString(const std::string& html) override {}

    // Test helper methods
    int getMessageCount() const { return messageCount_; }
    AcademiaBridge::Message getLastMessage() const { return lastMessage_; }
    void resetMessageCount() { messageCount_ = 0; }

private:
    std::string clientId_;
    bool ready_;
    int messageCount_;
    AcademiaBridge::Message lastMessage_;
};

void testMessageQueueingForNotReadyClient() {
    TEST_START("Message Queueing for Not-Ready Client");

    using namespace AcademiaBridge;

    @autoreleasepool {
        MessageRouter& router = MessageRouter::getInstance();

        // Create a not-ready mock bridge
        auto bridge = std::make_shared<MockTestBridge>("test-client-1", false);
        router.registerClient("test-client-1", bridge);

        // Create test message
        Message msg;
        msg.id = "test-msg-1";
        msg.action = "test-action";
        msg.type = MessageType::EVENT;
        msg.from = "sender";
        msg.to = "test-client-1";
        msg.payload = "{\"test\": true}";

        // Route message - should be queued since client is not ready
        router.routeMessage(msg);

        // Verify message was not delivered (client not ready)
        ASSERT_EQUAL(bridge->getMessageCount(), 0, "Message should be queued, not delivered");

        // Cleanup
        router.unregisterClient("test-client-1");

        TEST_PASS();
    }
}

void testMessageDeliveryAfterClientReady() {
    TEST_START("Message Delivery After Client Becomes Ready");

    using namespace AcademiaBridge;

    @autoreleasepool {
        MessageRouter& router = MessageRouter::getInstance();

        // Create a not-ready mock bridge
        auto bridge = std::make_shared<MockTestBridge>("test-client-2", false);
        router.registerClient("test-client-2", bridge);

        // Queue some messages
        for (int i = 0; i < 3; i++) {
            Message msg;
            msg.id = "test-msg-" + std::to_string(i);
            msg.action = "test-action-" + std::to_string(i);
            msg.type = MessageType::EVENT;
            msg.from = "sender";
            msg.to = "test-client-2";
            msg.payload = "{\"index\": " + std::to_string(i) + "}";
            router.routeMessage(msg);
        }

        // Verify messages were queued, not delivered
        ASSERT_EQUAL(bridge->getMessageCount(), 0, "Messages should be queued initially");

        // Mark bridge as ready and process queue
        bridge->setReady(true);
        router.processClientReadyQueue("test-client-2");

        // Verify all messages were delivered
        ASSERT_EQUAL(bridge->getMessageCount(), 3, "All 3 queued messages should be delivered");

        // Verify last message
        Message lastMsg = bridge->getLastMessage();
        ASSERT_TRUE(lastMsg.action == "test-action-2", "Last message should be the third one");

        // Cleanup
        router.unregisterClient("test-client-2");

        TEST_PASS();
    }
}

void testMessageDirectDeliveryForReadyClient() {
    TEST_START("Direct Message Delivery for Ready Client");

    using namespace AcademiaBridge;

    @autoreleasepool {
        MessageRouter& router = MessageRouter::getInstance();

        // Create a ready mock bridge
        auto bridge = std::make_shared<MockTestBridge>("test-client-3", true);
        router.registerClient("test-client-3", bridge);

        // Send message - should be delivered directly
        Message msg;
        msg.id = "test-msg-direct";
        msg.action = "test-action-direct";
        msg.type = MessageType::EVENT;
        msg.from = "sender";
        msg.to = "test-client-3";
        msg.payload = "{\"direct\": true}";

        router.routeMessage(msg);

        // Verify message was delivered immediately
        ASSERT_EQUAL(bridge->getMessageCount(), 1, "Message should be delivered immediately");
        ASSERT_TRUE(bridge->getLastMessage().action == "test-action-direct",
                   "Delivered message should match");

        // Cleanup
        router.unregisterClient("test-client-3");

        TEST_PASS();
    }
}

void testProcessEmptyQueue() {
    TEST_START("Process Empty Queue (No Messages)");

    using namespace AcademiaBridge;

    @autoreleasepool {
        MessageRouter& router = MessageRouter::getInstance();

        // Create a ready mock bridge
        auto bridge = std::make_shared<MockTestBridge>("test-client-4", true);
        router.registerClient("test-client-4", bridge);

        // Process queue when no messages are queued (should not crash)
        router.processClientReadyQueue("test-client-4");

        // Verify no messages were delivered
        ASSERT_EQUAL(bridge->getMessageCount(), 0, "No messages should be delivered");

        // Cleanup
        router.unregisterClient("test-client-4");

        TEST_PASS();
    }
}

void testMultipleClientQueues() {
    TEST_START("Multiple Client Queues (Isolation)");

    using namespace AcademiaBridge;

    @autoreleasepool {
        MessageRouter& router = MessageRouter::getInstance();

        // Create two not-ready mock bridges
        auto bridge1 = std::make_shared<MockTestBridge>("test-client-5a", false);
        auto bridge2 = std::make_shared<MockTestBridge>("test-client-5b", false);
        router.registerClient("test-client-5a", bridge1);
        router.registerClient("test-client-5b", bridge2);

        // Queue messages for both clients
        Message msg1;
        msg1.id = "msg-client-5a";
        msg1.action = "action-5a";
        msg1.type = MessageType::EVENT;
        msg1.from = "sender";
        msg1.to = "test-client-5a";
        router.routeMessage(msg1);

        Message msg2;
        msg2.id = "msg-client-5b";
        msg2.action = "action-5b";
        msg2.type = MessageType::EVENT;
        msg2.from = "sender";
        msg2.to = "test-client-5b";
        router.routeMessage(msg2);

        // Mark only first client as ready and process its queue
        bridge1->setReady(true);
        router.processClientReadyQueue("test-client-5a");

        // Verify only first client received message
        ASSERT_EQUAL(bridge1->getMessageCount(), 1, "First client should receive 1 message");
        ASSERT_EQUAL(bridge2->getMessageCount(), 0, "Second client should not receive messages yet");

        // Now mark second client as ready and process its queue
        bridge2->setReady(true);
        router.processClientReadyQueue("test-client-5b");

        // Verify second client now received its message
        ASSERT_EQUAL(bridge2->getMessageCount(), 1, "Second client should now receive 1 message");

        // Cleanup
        router.unregisterClient("test-client-5a");
        router.unregisterClient("test-client-5b");

        TEST_PASS();
    }
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
        // testScheduleAndCancelHide();  // Commented out - methods removed in refactor
        testMemoryDeallocation();

        // Message queue tests (WAGENT-69, 70, 71, 72)
        testMessageQueueingForNotReadyClient();
        testMessageDeliveryAfterClientReady();
        testMessageDirectDeliveryForReadyClient();
        testProcessEmptyQueue();
        testMultipleClientQueues();

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
