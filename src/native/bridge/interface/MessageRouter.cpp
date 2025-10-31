#include "MessageRouter.h"
#include <algorithm>
#include <iostream>

namespace AcademiaBridge {

// Singleton instance
MessageRouter& MessageRouter::getInstance() {
    static MessageRouter instance;
    return instance;
}

// Constructor
MessageRouter::MessageRouter()
    : isRunning_(false)
    , messagesSent_(0)
    , messagesReceived_(0)
    , requestsTimedOut_(0) {
}

// Destructor
MessageRouter::~MessageRouter() {
    stopProcessing();
}

// ========== Client Management ==========

void MessageRouter::registerClient(const std::string& clientId,
                                   std::shared_ptr<IWebViewBridge> bridge) {
    std::lock_guard<std::mutex> lock(clientsMutex_);

    if (clients_.find(clientId) != clients_.end()) {
        std::cerr << "[MessageRouter] Warning: Client " << clientId
                  << " already registered, replacing" << std::endl;
    }

    clients_[clientId] = bridge;
    std::cout << "[MessageRouter] Registered client: " << clientId
              << " (total: " << clients_.size() << ")" << std::endl;
}

void MessageRouter::unregisterClient(const std::string& clientId) {
    std::lock_guard<std::mutex> lock(clientsMutex_);

    auto it = clients_.find(clientId);
    if (it != clients_.end()) {
        clients_.erase(it);
        std::cout << "[MessageRouter] Unregistered client: " << clientId
                  << " (remaining: " << clients_.size() << ")" << std::endl;
    }
}

std::shared_ptr<IWebViewBridge> MessageRouter::getClient(const std::string& clientId) const {
    std::lock_guard<std::mutex> lock(clientsMutex_);

    auto it = clients_.find(clientId);
    if (it != clients_.end()) {
        return it->second;
    }
    return nullptr;
}

bool MessageRouter::hasClient(const std::string& clientId) const {
    std::lock_guard<std::mutex> lock(clientsMutex_);
    return clients_.find(clientId) != clients_.end();
}

size_t MessageRouter::getClientCount() const {
    std::lock_guard<std::mutex> lock(clientsMutex_);
    return clients_.size();
}

// ========== Message Routing ==========

void MessageRouter::routeMessage(const Message& msg) {
    messagesReceived_++;

    // Handle responses separately
    if (msg.type == MessageType::RESPONSE) {
        handleResponse(msg);
        return;
    }

    // Broadcast
    if (msg.to == "*" || msg.to.find('*') != std::string::npos) {
        broadcast(msg, msg.to);
        return;
    }

    // Unicast
    deliverMessage(msg.to, msg);
}

void MessageRouter::broadcast(const Message& msg, const std::string& pattern) {
    std::lock_guard<std::mutex> lock(clientsMutex_);

    size_t deliveredCount = 0;
    for (const auto& pair : clients_) {
        const std::string& clientId = pair.first;

        // Skip sender for broadcasts
        if (clientId == msg.from) {
            continue;
        }

        if (matchesPattern(clientId, pattern)) {
            deliverMessage(clientId, msg);
            deliveredCount++;
        }
    }

    std::cout << "[MessageRouter] Broadcast message '" << msg.action
              << "' from " << msg.from << " to " << deliveredCount
              << " clients (pattern: " << pattern << ")" << std::endl;
}

void MessageRouter::deliverMessage(const std::string& targetId, const Message& msg) {
    auto bridge = getClient(targetId);
    if (!bridge) {
        std::cerr << "[MessageRouter] Warning: Client " << targetId
                  << " not found for message: " << msg.action << std::endl;
        return;
    }

    if (!bridge->isReady()) {
        std::lock_guard<std::mutex> lock(clientQueuesMutex_);
        clientQueues_[targetId].push(msg);
        std::cout << "[MessageRouter] Queued message for not-ready client " << targetId
                  << ": " << msg.action << " (queue size: " << clientQueues_[targetId].size() << ")" << std::endl;
        return;
    }

    bridge->sendMessage(msg);
    messagesSent_++;
}

// ========== Request-Response ==========

void MessageRouter::sendRequest(const Message& msg, ResponseCallback callback) {
    if (msg.type != MessageType::REQUEST) {
        std::cerr << "[MessageRouter] Warning: sendRequest called with non-REQUEST message" << std::endl;
    }

    // Store pending request
    {
        std::lock_guard<std::mutex> lock(requestsMutex_);
        PendingRequest req;
        req.callback = callback;
        req.sentTime = std::chrono::steady_clock::now();
        req.timeoutMs = msg.timeoutMs;
        req.from = msg.from;

        pendingRequests_[msg.id] = req;
    }

    // Route the message
    routeMessage(msg);

    std::cout << "[MessageRouter] Request sent: " << msg.action
              << " (id: " << msg.id << ", timeout: " << msg.timeoutMs << "ms)" << std::endl;
}

void MessageRouter::handleResponse(const Message& response) {
    std::lock_guard<std::mutex> lock(requestsMutex_);

    auto it = pendingRequests_.find(response.id);
    if (it == pendingRequests_.end()) {
        std::cerr << "[MessageRouter] Warning: Response received for unknown request: "
                  << response.id << std::endl;
        return;
    }

    PendingRequest& req = it->second;

    // Calculate response time
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - req.sentTime);

    std::cout << "[MessageRouter] Response received: " << response.action
              << " (id: " << response.id << ", elapsed: " << elapsed.count() << "ms)" << std::endl;

    // Call callback
    if (req.callback) {
        req.callback(response);
    }

    // Remove from pending
    pendingRequests_.erase(it);
}

void MessageRouter::checkTimeouts() {
    std::lock_guard<std::mutex> lock(requestsMutex_);

    auto now = std::chrono::steady_clock::now();
    auto it = pendingRequests_.begin();

    while (it != pendingRequests_.end()) {
        const PendingRequest& req = it->second;
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - req.sentTime);

        if (elapsed.count() > req.timeoutMs) {
            std::cerr << "[MessageRouter] Request timeout: " << it->first
                      << " (elapsed: " << elapsed.count() << "ms)" << std::endl;

            // Create error response
            Message errorResponse;
            errorResponse.id = it->first;
            errorResponse.from = "router";
            errorResponse.to = req.from;
            errorResponse.type = MessageType::ERROR;
            errorResponse.action = "timeout";
            errorResponse.payload = "{\"error\":\"Request timed out\"}";

            // Call callback with error
            if (req.callback) {
                req.callback(errorResponse);
            }

            requestsTimedOut_++;
            it = pendingRequests_.erase(it);
        } else {
            ++it;
        }
    }
}

// ========== State Synchronization ==========

void MessageRouter::syncState(const std::string& key, const std::string& value) {
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        stateCache_[key] = value;
    }

    // Create state update message
    Message msg;
    msg.id = "state-" + key + "-" + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
    msg.from = "router";
    msg.to = "*";
    msg.type = MessageType::STATE_UPDATE;
    msg.action = "stateUpdate";
    msg.payload = "{\"key\":\"" + key + "\",\"value\":" + value + "}";
    msg.priority = Priority::HIGH;

    broadcast(msg);

    std::cout << "[MessageRouter] State synced: " << key << std::endl;
}

std::string MessageRouter::getState(const std::string& key) const {
    std::lock_guard<std::mutex> lock(stateMutex_);

    auto it = stateCache_.find(key);
    if (it != stateCache_.end()) {
        return it->second;
    }
    return "";
}

void MessageRouter::clearState() {
    std::lock_guard<std::mutex> lock(stateMutex_);
    stateCache_.clear();
    std::cout << "[MessageRouter] State cleared" << std::endl;
}

// ========== Queue Management ==========

void MessageRouter::startProcessing() {
    if (isRunning_) {
        std::cerr << "[MessageRouter] Processing already running" << std::endl;
        return;
    }

    isRunning_ = true;
    processingThread_ = std::make_unique<std::thread>(&MessageRouter::processQueue, this);

    std::cout << "[MessageRouter] Processing started" << std::endl;
}

void MessageRouter::stopProcessing() {
    if (!isRunning_) {
        return;
    }

    isRunning_ = false;

    if (processingThread_ && processingThread_->joinable()) {
        processingThread_->join();
    }
    processingThread_.reset();

    std::cout << "[MessageRouter] Processing stopped" << std::endl;
}

void MessageRouter::enqueueMessage(const Message& msg) {
    std::lock_guard<std::mutex> lock(queueMutex_);
    messageQueue_.push(std::make_shared<Message>(msg));
}

void MessageRouter::processClientReadyQueue(const std::string& clientId) {
    std::queue<Message> messagesToProcess;

    // Extract all queued messages for this client
    {
        std::lock_guard<std::mutex> lock(clientQueuesMutex_);
        auto it = clientQueues_.find(clientId);
        if (it != clientQueues_.end()) {
            messagesToProcess.swap(it->second);
            clientQueues_.erase(it);
        }
    }

    // Process messages outside the lock to avoid blocking other operations
    size_t messageCount = messagesToProcess.size();
    if (messageCount > 0) {
        std::cout << "[MessageRouter] Processing " << messageCount
                  << " queued messages for client " << clientId << std::endl;

        while (!messagesToProcess.empty()) {
            Message msg = messagesToProcess.front();
            messagesToProcess.pop();
            deliverMessage(clientId, msg);
        }

        std::cout << "[MessageRouter] Finished processing queued messages for client "
                  << clientId << std::endl;
    }
}

void MessageRouter::processQueue() {
    std::cout << "[MessageRouter] Processing thread started" << std::endl;

    auto lastTimeoutCheck = std::chrono::steady_clock::now();

    while (isRunning_) {
        // Process messages
        {
            std::unique_lock<std::mutex> lock(queueMutex_);

            if (!messageQueue_.empty()) {
                auto msg = messageQueue_.top();
                messageQueue_.pop();
                lock.unlock();

                routeMessage(*msg);
            } else {
                lock.unlock();
                // Sleep briefly if queue is empty
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
        }

        // Check timeouts every 100ms
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - lastTimeoutCheck);
        if (elapsed.count() > 100) {
            checkTimeouts();
            lastTimeoutCheck = now;
        }
    }

    std::cout << "[MessageRouter] Processing thread stopped" << std::endl;
}

// ========== Pattern Matching ==========

bool MessageRouter::matchesPattern(const std::string& clientId,
                                  const std::string& pattern) const {
    // Exact match
    if (pattern == clientId) {
        return true;
    }

    // Wildcard match all
    if (pattern == "*") {
        return true;
    }

    // Prefix wildcard (e.g., "popup-*")
    if (pattern.length() > 0 && pattern.back() == '*') {
        std::string prefix = pattern.substr(0, pattern.length() - 1);
        return clientId.compare(0, prefix.length(), prefix) == 0;
    }

    // Suffix wildcard (e.g., "*-popup")
    if (pattern.length() > 0 && pattern.front() == '*') {
        std::string suffix = pattern.substr(1);
        if (clientId.length() >= suffix.length()) {
            return clientId.compare(clientId.length() - suffix.length(),
                                   suffix.length(), suffix) == 0;
        }
    }

    return false;
}

// ========== Statistics ==========

MessageRouter::Stats MessageRouter::getStats() const {
    Stats stats;
    stats.messagesSent = messagesSent_.load();
    stats.messagesReceived = messagesReceived_.load();
    stats.requestsTimedOut = requestsTimedOut_.load();

    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        stats.queueSize = messageQueue_.size();
    }

    {
        std::lock_guard<std::mutex> lock(requestsMutex_);
        stats.pendingRequests = pendingRequests_.size();
    }

    return stats;
}

} // namespace AcademiaBridge
