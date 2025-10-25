#pragma once

#include "Message.h"
#include <functional>
#include <memory>

namespace AcademiaBridge {

// Message handler callback type
using MessageHandler = std::function<void(const Message&)>;

// Response callback type (for async request-response)
using ResponseCallback = std::function<void(const Message&)>;

/**
 * Abstract WebView Bridge Interface
 *
 * This interface abstracts platform-specific WebView implementations
 * (WKWebView on macOS, WebView2 on Windows) to provide a unified
 * bidirectional communication layer.
 */
class IWebViewBridge {
public:
    virtual ~IWebViewBridge() = default;

    // ========== Lifecycle ==========

    /**
     * Initialize the bridge and create platform-specific resources
     * @return true if initialization succeeded
     */
    virtual bool initialize() = 0;

    /**
     * Clean up and destroy platform-specific resources
     */
    virtual void destroy() = 0;

    /**
     * Check if the bridge is ready for communication
     * @return true if JavaScript side has signaled readiness
     */
    virtual bool isReady() const = 0;

    // ========== Client Identification ==========

    /**
     * Get unique client ID for this bridge instance
     * @return client ID string (e.g., "popup-12345", "main")
     */
    virtual std::string getClientId() const = 0;

    /**
     * Set client ID for this bridge instance
     * @param id client ID string
     */
    virtual void setClientId(const std::string& id) = 0;

    // ========== Messaging ==========

    /**
     * Send a message to the JavaScript side (fire-and-forget)
     * @param msg message to send
     */
    virtual void sendMessage(const Message& msg) = 0;

    /**
     * Send a message and register callback for response (async request-response)
     * @param msg message to send (type should be REQUEST)
     * @param callback function to call when response arrives or timeout occurs
     */
    virtual void sendMessageAsync(const Message& msg, ResponseCallback callback) = 0;

    // ========== Handler Registration ==========

    /**
     * Register a handler for messages with a specific action
     * @param action action name to handle (e.g., "buttonClick")
     * @param handler callback function to invoke when message arrives
     */
    virtual void registerHandler(const std::string& action, MessageHandler handler) = 0;

    /**
     * Unregister a previously registered handler
     * @param action action name to unregister
     */
    virtual void unregisterHandler(const std::string& action) = 0;

    // ========== Window Management ==========

    /**
     * Show the WebView window
     */
    virtual void showWindow() = 0;

    /**
     * Hide the WebView window
     */
    virtual void hideWindow() = 0;

    /**
     * Set window position on screen
     * @param x horizontal position in screen coordinates
     * @param y vertical position in screen coordinates
     */
    virtual void setWindowPosition(int x, int y) = 0;

    /**
     * Set window size
     * @param width window width in pixels
     * @param height window height in pixels
     */
    virtual void setWindowSize(int width, int height) = 0;

    /**
     * Get window position
     * @param outX reference to receive x coordinate
     * @param outY reference to receive y coordinate
     */
    virtual void getWindowPosition(int& outX, int& outY) const = 0;

    /**
     * Get window size
     * @param outWidth reference to receive width
     * @param outHeight reference to receive height
     */
    virtual void getWindowSize(int& outWidth, int& outHeight) const = 0;

    // ========== Content Loading ==========

    /**
     * Load HTML file from path
     * @param htmlPath file path to HTML file
     */
    virtual void loadHTML(const std::string& htmlPath) = 0;

    /**
     * Load HTML from string
     * @param html HTML content as string
     */
    virtual void loadHTMLString(const std::string& html) = 0;
};

} // namespace AcademiaBridge
