#import "MacOSWebViewBridge.h"
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <iostream>
#include "MessageRouter.h"

// Forward declare to break circular dependency
@interface BridgeMessageHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) AcademiaBridge::MacOSWebViewBridge* bridge;
- (instancetype)initWithBridge:(AcademiaBridge::MacOSWebViewBridge*)bridge;
@end

@implementation BridgeMessageHandler

- (instancetype)initWithBridge:(AcademiaBridge::MacOSWebViewBridge*)bridge {
    self = [super init];
    if (self) {
        _bridge = bridge;
    }
    return self;
}

- (void)userContentController:(WKUserContentController*)userContentController
      didReceiveScriptMessage:(WKScriptMessage*)message {
    if (!_bridge) {
        NSLog(@"[BridgeMessageHandler] Bridge pointer is null!");
        return;
    }

    // Get JSON string from message
    NSString* jsonStr = nil;
    if ([message.body isKindOfClass:[NSString class]]) {
        jsonStr = (NSString*)message.body;
    } else if ([message.body isKindOfClass:[NSDictionary class]]) {
        // Convert dict to JSON
        NSError* error = nil;
        NSData* jsonData = [NSJSONSerialization dataWithJSONObject:message.body
                                                           options:0
                                                             error:&error];
        if (jsonData && !error) {
            jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
        }
    }

    if (jsonStr) {
        std::string json = [jsonStr UTF8String];
        _bridge->handleMessageFromJS(json);
    } else {
        NSLog(@"[BridgeMessageHandler] Failed to extract JSON from message");
    }
}

@end

namespace AcademiaBridge {

// Constructor
MacOSWebViewBridge::MacOSWebViewBridge()
    : isReady_(false)
    , isInitialized_(false)
    , panel_(nil)
    , webView_(nil)
    , messageHandler_(nil) {
}

// Destructor
MacOSWebViewBridge::~MacOSWebViewBridge() {
    destroy();
}

// ========== Lifecycle ==========

bool MacOSWebViewBridge::initialize() {
    if (isInitialized_) {
        std::cerr << "[MacOSWebViewBridge] Already initialized" << std::endl;
        return true;
    }

    @autoreleasepool {
        // Create NSPanel (non-activating window)
        CGFloat width = 380;
        CGFloat height = 220;

        panel_ = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, width, height)
                                           styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                             backing:NSBackingStoreBuffered
                                               defer:NO];

        if (!panel_) {
            std::cerr << "[MacOSWebViewBridge] Failed to create NSPanel" << std::endl;
            return false;
        }

        setupWindowStyle();
        setupWebView();
        setupMessageHandlers();

        isInitialized_ = true;
        std::cout << "[MacOSWebViewBridge] Initialized successfully" << std::endl;
        return true;
    }
}

void MacOSWebViewBridge::destroy() {
    if (!isInitialized_) {
        return;
    }

    @autoreleasepool {
        // Clean up WKWebView
        if (webView_) {
            [webView_ stopLoading];
            [webView_.configuration.userContentController removeScriptMessageHandlerForName:@"bridge"];
            webView_ = nil;
        }

        // Clean up panel
        if (panel_) {
            [panel_ orderOut:nil];
            [panel_ close];
            panel_ = nil;
        }

        messageHandler_ = nil;
    }

    isInitialized_ = false;
    isReady_ = false;

    std::cout << "[MacOSWebViewBridge] Destroyed" << std::endl;
}

// ========== Setup Methods ==========

void MacOSWebViewBridge::setupWindowStyle() {
    panel_.backgroundColor = [NSColor clearColor];
    panel_.opaque = NO;
    panel_.level = NSFloatingWindowLevel + 1;
    panel_.hasShadow = NO;
    panel_.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                NSWindowCollectionBehaviorStationary;

    // CRITICAL: Make non-activating
    panel_.floatingPanel = YES;
    panel_.becomesKeyOnlyIfNeeded = NO;
    panel_.worksWhenModal = YES;
    panel_.hidesOnDeactivate = NO;

    // Enable mouse events
    panel_.ignoresMouseEvents = NO;
    panel_.acceptsMouseMovedEvents = YES;
}

void MacOSWebViewBridge::setupWebView() {
    // Configure WKWebView
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    config.preferences.javaScriptEnabled = YES;

    // Create WKWebView
    webView_ = [[WKWebView alloc] initWithFrame:panel_.contentView.bounds
                                  configuration:config];
    webView_.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    // Make background transparent
    [webView_ setValue:@NO forKey:@"drawsBackground"];

    [panel_.contentView addSubview:webView_];
}

void MacOSWebViewBridge::setupMessageHandlers() {
    WKUserContentController* controller = webView_.configuration.userContentController;

    // Create message handler
    messageHandler_ = [[BridgeMessageHandler alloc] initWithBridge:this];
    [controller addScriptMessageHandler:messageHandler_ name:@"bridge"];

    // Inject bridge initialization script
    injectBridgeScript();
}

void MacOSWebViewBridge::injectBridgeScript() {
    // Bridge JavaScript code
    // This creates a global __bridge object that JS can use to communicate
    NSString* bridgeJS = @
        "(function() {"
        "  console.log('[Bridge] Initializing message bridge');"
        ""
        "  // Message handlers registry"
        "  window.__bridgeHandlers = {};"
        ""
        "  // Send message to native"
        "  window.__bridgeSend = function(msg) {"
        "    if (!msg.id) {"
        "      msg.id = 'js-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);"
        "    }"
        "    if (!msg.timestamp) {"
        "      msg.timestamp = Date.now();"
        "    }"
        "    window.webkit.messageHandlers.bridge.postMessage(msg);"
        "  };"
        ""
        "  // Receive message from native"
        "  window.__bridgeReceive = function(msg) {"
        "    console.log('[Bridge] Received:', msg.action);"
        ""
        "    const handler = window.__bridgeHandlers[msg.action];"
        "    if (handler) {"
        "      handler(msg);"
        "    } else {"
        "      console.warn('[Bridge] No handler for action:', msg.action);"
        "    }"
        "  };"
        ""
        "  // Register handler"
        "  window.__bridgeOn = function(action, handler) {"
        "    console.log('[Bridge] Registering handler:', action);"
        "    window.__bridgeHandlers[action] = handler;"
        "  };"
        ""
        "  // Unregister handler"
        "  window.__bridgeOff = function(action) {"
        "    delete window.__bridgeHandlers[action];"
        "  };"
        ""
        "  // Send ready signal after a short delay"
        "  setTimeout(function() {"
        "    console.log('[Bridge] Sending ready signal');"
        "    window.__bridgeSend({"
        "      type: 'event',"
        "      action: 'bridge-ready',"
        "      payload: null"
        "    });"
        "  }, 100);"
        ""
        "  console.log('[Bridge] Initialization complete');"
        "})();";

    WKUserScript* script = [[WKUserScript alloc]
        initWithSource:bridgeJS
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart
        forMainFrameOnly:YES];

    [webView_.configuration.userContentController addUserScript:script];
}

// ========== Messaging ==========

void MacOSWebViewBridge::sendMessage(const Message& msg) {
    if (!isInitialized_) {
        std::cerr << "[MacOSWebViewBridge] Cannot send message: not initialized" << std::endl;
        return;
    }

    if (!isReady_) {
        std::cout << "[MacOSWebViewBridge] Warning: Sending message before JS ready: "
                  << msg.action << std::endl;
    }

    std::string json = msg.toJSON();
    std::string jsCode = "window.__bridgeReceive(" + json + ");";

    executeJavaScript(jsCode);
}

void MacOSWebViewBridge::sendMessageAsync(const Message& msg, ResponseCallback callback) {
    // Store callback for this message ID
    {
        std::lock_guard<std::mutex> lock(callbacksMutex_);
        responseCallbacks_[msg.id] = callback;
    }

    // Send the message
    sendMessage(msg);
}

void MacOSWebViewBridge::handleMessageFromJS(const std::string& json) {
    // Parse message
    auto msg = Message::fromJSON(json);
    if (!msg) {
        std::cerr << "[MacOSWebViewBridge] Failed to parse message from JS" << std::endl;
        return;
    }

    // Handle special bridge-ready message
    if (msg->action == "bridge-ready") {
        isReady_ = true;
        std::cout << "[MacOSWebViewBridge] JavaScript bridge is ready" << std::endl;

        // Notify router that client is ready (to process queued messages)
        MessageRouter::getInstance().processClientReadyQueue(clientId_);
        return;
    }

    // Handle responses to async requests
    if (msg->type == MessageType::RESPONSE) {
        std::lock_guard<std::mutex> lock(callbacksMutex_);
        auto it = responseCallbacks_.find(msg->id);
        if (it != responseCallbacks_.end()) {
            ResponseCallback callback = it->second;
            responseCallbacks_.erase(it);

            // Call callback
            callback(*msg);
            return;
        }
    }

    // Process through registered handlers
    handleIncomingMessage(*msg);
}

void MacOSWebViewBridge::handleIncomingMessage(const Message& msg) {
    std::lock_guard<std::mutex> lock(handlersMutex_);

    auto it = handlers_.find(msg.action);
    if (it != handlers_.end()) {
        // Call handler
        it->second(msg);
    } else {
        std::cout << "[MacOSWebViewBridge] No handler registered for action: "
                  << msg.action << std::endl;
    }
}

void MacOSWebViewBridge::executeJavaScript(const std::string& js) {
    NSString* jsCode = [NSString stringWithUTF8String:js.c_str()];

    [webView_ evaluateJavaScript:jsCode completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"[MacOSWebViewBridge] JavaScript error: %@", error.localizedDescription);
        }
    }];
}

// ========== Handler Registration ==========

void MacOSWebViewBridge::registerHandler(const std::string& action, MessageHandler handler) {
    std::lock_guard<std::mutex> lock(handlersMutex_);
    handlers_[action] = handler;
    std::cout << "[MacOSWebViewBridge] Registered handler: " << action << std::endl;
}

void MacOSWebViewBridge::unregisterHandler(const std::string& action) {
    std::lock_guard<std::mutex> lock(handlersMutex_);
    handlers_.erase(action);
    std::cout << "[MacOSWebViewBridge] Unregistered handler: " << action << std::endl;
}

// ========== Window Management ==========

void MacOSWebViewBridge::showWindow() {
    if (panel_) {
        [panel_ orderFrontRegardless];
        std::cout << "[MacOSWebViewBridge] Window shown" << std::endl;
    }
}

void MacOSWebViewBridge::hideWindow() {
    if (panel_) {
        [panel_ orderOut:nil];
        std::cout << "[MacOSWebViewBridge] Window hidden" << std::endl;
    }
}

void MacOSWebViewBridge::setWindowPosition(int x, int y) {
    if (panel_) {
        [panel_ setFrameOrigin:NSMakePoint(x, y)];
    }
}

void MacOSWebViewBridge::setWindowSize(int width, int height) {
    if (panel_) {
        NSRect frame = panel_.frame;
        frame.size = NSMakeSize(width, height);
        [panel_ setFrame:frame display:YES];
    }
}

void MacOSWebViewBridge::getWindowPosition(int& outX, int& outY) const {
    if (panel_) {
        NSPoint origin = panel_.frame.origin;
        outX = static_cast<int>(origin.x);
        outY = static_cast<int>(origin.y);
    } else {
        outX = 0;
        outY = 0;
    }
}

void MacOSWebViewBridge::getWindowSize(int& outWidth, int& outHeight) const {
    if (panel_) {
        NSSize size = panel_.frame.size;
        outWidth = static_cast<int>(size.width);
        outHeight = static_cast<int>(size.height);
    } else {
        outWidth = 0;
        outHeight = 0;
    }
}

// ========== Content Loading ==========

void MacOSWebViewBridge::loadHTML(const std::string& htmlPath) {
    if (!isInitialized_) {
        std::cerr << "[MacOSWebViewBridge] Cannot load HTML: not initialized" << std::endl;
        return;
    }

    NSString* path = [NSString stringWithUTF8String:htmlPath.c_str()];
    NSURL* url = [NSURL fileURLWithPath:path];

    if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
        NSURLRequest* request = [NSURLRequest requestWithURL:url];
        [webView_ loadRequest:request];
        std::cout << "[MacOSWebViewBridge] Loading HTML from: " << htmlPath << std::endl;
    } else {
        std::cerr << "[MacOSWebViewBridge] HTML file not found: " << htmlPath << std::endl;
    }
}

void MacOSWebViewBridge::loadHTMLString(const std::string& html) {
    if (!isInitialized_) {
        std::cerr << "[MacOSWebViewBridge] Cannot load HTML: not initialized" << std::endl;
        return;
    }

    NSString* htmlStr = [NSString stringWithUTF8String:html.c_str()];
    [webView_ loadHTMLString:htmlStr baseURL:nil];
    std::cout << "[MacOSWebViewBridge] Loading HTML string (" << html.length() << " bytes)" << std::endl;
}

} // namespace AcademiaBridge
