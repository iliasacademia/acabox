#pragma once

#include "../interface/IWebViewBridge.h"
#include <map>
#include <mutex>

#ifdef __OBJC__
@class NSPanel;
@class WKWebView;
@class BridgeMessageHandler;
#else
typedef struct objc_object NSPanel;
typedef struct objc_object WKWebView;
typedef struct objc_object BridgeMessageHandler;
#endif

namespace AcademiaBridge {

/**
 * macOS WebView Bridge Implementation
 *
 * Uses WKWebView for rendering and NSPanel for window management.
 * Communicates via WKScriptMessageHandler (JS→Native) and
 * evaluateJavaScript (Native→JS).
 */
class MacOSWebViewBridge : public IWebViewBridge {
public:
    MacOSWebViewBridge();
    ~MacOSWebViewBridge() override;

    // ========== IWebViewBridge Implementation ==========

    // Lifecycle
    bool initialize() override;
    void destroy() override;
    bool isReady() const override { return isReady_; }

    // Client identification
    std::string getClientId() const override { return clientId_; }
    void setClientId(const std::string& id) override { clientId_ = id; }

    // Messaging
    void sendMessage(const Message& msg) override;
    void sendMessageAsync(const Message& msg, ResponseCallback callback) override;

    // Handler registration
    void registerHandler(const std::string& action, MessageHandler handler) override;
    void unregisterHandler(const std::string& action) override;

    // Window management
    void showWindow() override;
    void hideWindow() override;
    void setWindowPosition(int x, int y) override;
    void setWindowSize(int width, int height) override;
    void getWindowPosition(int& outX, int& outY) const override;
    void getWindowSize(int& outWidth, int& outHeight) const override;

    // Content loading
    void loadHTML(const std::string& htmlPath) override;
    void loadHTMLString(const std::string& html) override;

    // ========== Platform-Specific Methods ==========

    /**
     * Get native NSPanel handle
     * @return pointer to NSPanel
     */
    NSPanel* getPanel() const { return panel_; }

    /**
     * Get native WKWebView handle
     * @return pointer to WKWebView
     */
    WKWebView* getWebView() const { return webView_; }

    /**
     * Handle message received from JavaScript
     * Called by BridgeMessageHandler
     * @param json JSON string from JavaScript
     */
    void handleMessageFromJS(const std::string& json);

    /**
     * Signal that JavaScript side is ready
     * Called when JS sends "bridge-ready" message
     */
    void setReady(bool ready) { isReady_ = ready; }

private:
    // State
    std::string clientId_;
    bool isReady_;
    bool isInitialized_;

    // Native handles
    NSPanel* panel_;
    WKWebView* webView_;
    BridgeMessageHandler* messageHandler_;

    // Message handlers
    std::map<std::string, MessageHandler> handlers_;
    std::mutex handlersMutex_;

    // Async response callbacks (for request-response pattern)
    std::map<std::string, ResponseCallback> responseCallbacks_;
    std::mutex callbacksMutex_;

    // Setup methods
    void setupWebView();
    void setupMessageHandlers();
    void injectBridgeScript();
    void setupWindowStyle();

    // Helper methods
    void executeJavaScript(const std::string& js);
    void handleIncomingMessage(const Message& msg);
};

} // namespace AcademiaBridge
