#pragma once

#include <string>
#include <chrono>
#include <map>
#include <memory>

namespace AcademiaBridge {

// Message types
enum class MessageType {
    REQUEST,      // Expects response
    RESPONSE,     // Response to request
    EVENT,        // Fire-and-forget notification
    STATE_UPDATE, // State synchronization
    ERROR         // Error message
};

// Priority levels for queue
enum class Priority {
    HIGH = 0,     // User interactions, critical updates
    NORMAL = 1,   // Regular messages
    LOW = 2       // Background sync, logging
};

// Convert enum to string
const char* messageTypeToString(MessageType type);
const char* priorityToString(Priority priority);
MessageType stringToMessageType(const std::string& str);
Priority stringToPriority(const std::string& str);

// Core message structure
struct Message {
    std::string id;           // Unique message ID (for request-response tracking)
    std::string from;         // Client ID sender
    std::string to;           // Client ID receiver ("*" = broadcast)
    MessageType type;
    std::string action;       // Action name (e.g., "updateContent", "buttonClick")
    std::string payload;      // JSON string payload
    Priority priority = Priority::NORMAL;
    int64_t timestamp;        // Unix timestamp in milliseconds
    int64_t timeoutMs = 5000; // Response timeout

    // Constructors
    Message();
    Message(const std::string& from, const std::string& to,
            MessageType type, const std::string& action);

    // Serialization
    std::string toJSON() const;
    static std::unique_ptr<Message> fromJSON(const std::string& json);

    // Utility
    bool isExpired() const;
    int64_t getAge() const;
};

} // namespace AcademiaBridge
