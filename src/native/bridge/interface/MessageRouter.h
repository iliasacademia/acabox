#pragma once

#include "IWebViewBridge.h"
#include "Message.h"
#include <map>
#include <queue>
#include <mutex>
#include <thread>
#include <atomic>
#include <memory>
#include <chrono>

namespace AcademiaBridge {

/**
 * MessageRouter - Central hub for routing messages between clients
 *
 * Manages:
 * - Multiple WebView bridge instances (popups, windows)
 * - Message routing (unicast, broadcast, pattern-based)
 * - Request-response tracking with timeouts
 * - State synchronization across clients
 * - Priority-based message queue
 */
class MessageRouter {
public:
    // Singleton access
    static MessageRouter& getInstance();

    // Prevent copying
    MessageRouter(const MessageRouter&) = delete;
    MessageRouter& operator=(const MessageRouter&) = delete;

    // ========== Client Management ==========

    /**
     * Register a new client bridge
     * @param clientId unique client identifier
     * @param bridge shared pointer to bridge instance
     */
    void registerClient(const std::string& clientId, std::shared_ptr<IWebViewBridge> bridge);

    /**
     * Unregister a client bridge
     * @param clientId client identifier to remove
     */
    void unregisterClient(const std::string& clientId);

    /**
     * Get a registered client bridge
     * @param clientId client identifier
     * @return shared pointer to bridge, or nullptr if not found
     */
    std::shared_ptr<IWebViewBridge> getClient(const std::string& clientId) const;

    /**
     * Check if a client is registered
     * @param clientId client identifier
     * @return true if client exists
     */
    bool hasClient(const std::string& clientId) const;

    /**
     * Get count of registered clients
     * @return number of active clients
     */
    size_t getClientCount() const;

    // ========== Message Routing ==========

    /**
     * Route a message to its destination(s)
     * Handles unicast, broadcast, and pattern matching
     * @param msg message to route
     */
    void routeMessage(const Message& msg);

    /**
     * Broadcast a message to all clients matching a pattern
     * @param msg message to broadcast
     * @param pattern client ID pattern ("*" = all, "popup-*" = all popups, etc.)
     */
    void broadcast(const Message& msg, const std::string& pattern = "*");

    // ========== Request-Response ==========

    /**
     * Send a request and register callback for response
     * @param msg request message (type should be REQUEST)
     * @param callback function to call when response arrives or timeout occurs
     */
    void sendRequest(const Message& msg, ResponseCallback callback);

    /**
     * Handle a response to a pending request
     * @param response response message (type should be RESPONSE)
     */
    void handleResponse(const Message& response);

    // ========== State Synchronization ==========

    /**
     * Sync a state value to all clients
     * @param key state key
     * @param value state value (JSON string)
     */
    void syncState(const std::string& key, const std::string& value);

    /**
     * Get current state value
     * @param key state key
     * @return state value, or empty string if not found
     */
    std::string getState(const std::string& key) const;

    /**
     * Clear all state
     */
    void clearState();

    // ========== Queue Management ==========

    /**
     * Start background message processing thread
     */
    void startProcessing();

    /**
     * Stop background processing thread
     */
    void stopProcessing();

    /**
     * Check if processing thread is running
     * @return true if running
     */
    bool isProcessing() const { return isRunning_; }

    /**
     * Enqueue a message for processing
     * @param msg message to enqueue
     */
    void enqueueMessage(const Message& msg);

    // ========== Statistics ==========

    struct Stats {
        uint64_t messagesSent = 0;
        uint64_t messagesReceived = 0;
        uint64_t requestsTimedOut = 0;
        uint64_t queueSize = 0;
        uint64_t pendingRequests = 0;
    };

    /**
     * Get router statistics
     * @return stats structure
     */
    Stats getStats() const;

private:
    MessageRouter();
    ~MessageRouter();

    // Pending request tracking
    struct PendingRequest {
        ResponseCallback callback;
        std::chrono::steady_clock::time_point sentTime;
        int64_t timeoutMs;
        std::string from;
    };

    // Priority queue comparator (lower priority value = higher priority)
    struct MessageComparator {
        bool operator()(const std::shared_ptr<Message>& a,
                       const std::shared_ptr<Message>& b) const {
            return static_cast<int>(a->priority) > static_cast<int>(b->priority);
        }
    };

    // Data members
    std::map<std::string, std::shared_ptr<IWebViewBridge>> clients_;
    std::map<std::string, std::string> stateCache_;
    std::map<std::string, PendingRequest> pendingRequests_;

    std::priority_queue<std::shared_ptr<Message>,
                       std::vector<std::shared_ptr<Message>>,
                       MessageComparator> messageQueue_;

    mutable std::mutex clientsMutex_;
    mutable std::mutex queueMutex_;
    mutable std::mutex stateMutex_;
    mutable std::mutex requestsMutex_;

    std::unique_ptr<std::thread> processingThread_;
    std::atomic<bool> isRunning_;

    // Statistics
    mutable std::atomic<uint64_t> messagesSent_;
    mutable std::atomic<uint64_t> messagesReceived_;
    mutable std::atomic<uint64_t> requestsTimedOut_;

    // Internal methods
    void processQueue();
    void checkTimeouts();
    bool matchesPattern(const std::string& clientId, const std::string& pattern) const;
    void deliverMessage(const std::string& targetId, const Message& msg);
};

} // namespace AcademiaBridge
