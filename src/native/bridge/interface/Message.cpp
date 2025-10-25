#include "Message.h"
#include <sstream>
#include <ctime>

namespace AcademiaBridge {

// Helper to get current timestamp in milliseconds
static int64_t getCurrentTimestampMs() {
    auto now = std::chrono::system_clock::now();
    auto duration = now.time_since_epoch();
    return std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
}

// Enum to string conversions
const char* messageTypeToString(MessageType type) {
    switch (type) {
        case MessageType::REQUEST: return "request";
        case MessageType::RESPONSE: return "response";
        case MessageType::EVENT: return "event";
        case MessageType::STATE_UPDATE: return "state-update";
        case MessageType::ERROR: return "error";
        default: return "unknown";
    }
}

const char* priorityToString(Priority priority) {
    switch (priority) {
        case Priority::HIGH: return "high";
        case Priority::NORMAL: return "normal";
        case Priority::LOW: return "low";
        default: return "normal";
    }
}

MessageType stringToMessageType(const std::string& str) {
    if (str == "request") return MessageType::REQUEST;
    if (str == "response") return MessageType::RESPONSE;
    if (str == "event") return MessageType::EVENT;
    if (str == "state-update") return MessageType::STATE_UPDATE;
    if (str == "error") return MessageType::ERROR;
    return MessageType::EVENT;
}

Priority stringToPriority(const std::string& str) {
    if (str == "high") return Priority::HIGH;
    if (str == "normal") return Priority::NORMAL;
    if (str == "low") return Priority::LOW;
    return Priority::NORMAL;
}

// Simple JSON escaping
static std::string escapeJSON(const std::string& str) {
    std::string result;
    result.reserve(str.length());

    for (char c : str) {
        switch (c) {
            case '"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default: result += c; break;
        }
    }

    return result;
}

// Simple JSON unescaping
static std::string unescapeJSON(const std::string& str) {
    std::string result;
    result.reserve(str.length());

    bool escaped = false;
    for (char c : str) {
        if (escaped) {
            switch (c) {
                case 'n': result += '\n'; break;
                case 'r': result += '\r'; break;
                case 't': result += '\t'; break;
                default: result += c; break;
            }
            escaped = false;
        } else if (c == '\\') {
            escaped = true;
        } else {
            result += c;
        }
    }

    return result;
}

// Extract string value from JSON (simple parser for string fields)
static std::string extractJSONString(const std::string& json, const std::string& key) {
    std::string searchKey = "\"" + key + "\":\"";
    size_t startPos = json.find(searchKey);
    if (startPos == std::string::npos) {
        return "";
    }

    startPos += searchKey.length();
    size_t endPos = startPos;

    // Find closing quote (handling escaped quotes)
    bool escaped = false;
    while (endPos < json.length()) {
        if (escaped) {
            escaped = false;
        } else if (json[endPos] == '\\') {
            escaped = true;
        } else if (json[endPos] == '"') {
            break;
        }
        endPos++;
    }

    if (endPos >= json.length()) {
        return "";
    }

    return unescapeJSON(json.substr(startPos, endPos - startPos));
}

// Extract number value from JSON
static int64_t extractJSONNumber(const std::string& json, const std::string& key, int64_t defaultValue = 0) {
    std::string searchKey = "\"" + key + "\":";
    size_t startPos = json.find(searchKey);
    if (startPos == std::string::npos) {
        return defaultValue;
    }

    startPos += searchKey.length();

    // Skip whitespace
    while (startPos < json.length() && std::isspace(json[startPos])) {
        startPos++;
    }

    // Extract number
    size_t endPos = startPos;
    while (endPos < json.length() && (std::isdigit(json[endPos]) || json[endPos] == '-')) {
        endPos++;
    }

    if (endPos == startPos) {
        return defaultValue;
    }

    try {
        return std::stoll(json.substr(startPos, endPos - startPos));
    } catch (...) {
        return defaultValue;
    }
}

// Message constructors
Message::Message()
    : type(MessageType::EVENT)
    , priority(Priority::NORMAL)
    , timestamp(getCurrentTimestampMs())
    , timeoutMs(5000) {
}

Message::Message(const std::string& from, const std::string& to,
                 MessageType type, const std::string& action)
    : from(from)
    , to(to)
    , type(type)
    , action(action)
    , priority(Priority::NORMAL)
    , timestamp(getCurrentTimestampMs())
    , timeoutMs(5000) {
}

// Serialize to JSON
std::string Message::toJSON() const {
    std::ostringstream oss;
    oss << "{"
        << "\"id\":\"" << escapeJSON(id) << "\","
        << "\"from\":\"" << escapeJSON(from) << "\","
        << "\"to\":\"" << escapeJSON(to) << "\","
        << "\"type\":\"" << messageTypeToString(type) << "\","
        << "\"action\":\"" << escapeJSON(action) << "\","
        << "\"payload\":" << (payload.empty() ? "null" : payload) << ","
        << "\"priority\":\"" << priorityToString(priority) << "\","
        << "\"timestamp\":" << timestamp << ","
        << "\"timeoutMs\":" << timeoutMs
        << "}";

    return oss.str();
}

// Deserialize from JSON
std::unique_ptr<Message> Message::fromJSON(const std::string& json) {
    auto msg = std::make_unique<Message>();

    msg->id = extractJSONString(json, "id");
    msg->from = extractJSONString(json, "from");
    msg->to = extractJSONString(json, "to");
    msg->type = stringToMessageType(extractJSONString(json, "type"));
    msg->action = extractJSONString(json, "action");

    // Extract payload (everything between "payload": and the next comma or })
    std::string payloadKey = "\"payload\":";
    size_t payloadStart = json.find(payloadKey);
    if (payloadStart != std::string::npos) {
        payloadStart += payloadKey.length();

        // Skip whitespace
        while (payloadStart < json.length() && std::isspace(json[payloadStart])) {
            payloadStart++;
        }

        // Find end of payload (next comma at same level, or closing brace)
        size_t payloadEnd = payloadStart;
        int braceDepth = 0;
        int bracketDepth = 0;
        bool inString = false;
        bool escaped = false;

        while (payloadEnd < json.length()) {
            char c = json[payloadEnd];

            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                inString = !inString;
            } else if (!inString) {
                if (c == '{') braceDepth++;
                else if (c == '}') {
                    if (braceDepth > 0) braceDepth--;
                    else break; // End of message object
                } else if (c == '[') bracketDepth++;
                else if (c == ']') bracketDepth--;
                else if (c == ',' && braceDepth == 0 && bracketDepth == 0) {
                    break; // End of payload field
                }
            }

            payloadEnd++;
        }

        msg->payload = json.substr(payloadStart, payloadEnd - payloadStart);

        // Trim whitespace
        size_t start = msg->payload.find_first_not_of(" \t\n\r");
        size_t end = msg->payload.find_last_not_of(" \t\n\r");
        if (start != std::string::npos && end != std::string::npos) {
            msg->payload = msg->payload.substr(start, end - start + 1);
        }

        // If payload is "null", clear it
        if (msg->payload == "null") {
            msg->payload.clear();
        }
    }

    msg->priority = stringToPriority(extractJSONString(json, "priority"));
    msg->timestamp = extractJSONNumber(json, "timestamp", getCurrentTimestampMs());
    msg->timeoutMs = extractJSONNumber(json, "timeoutMs", 5000);

    return msg;
}

// Utility methods
bool Message::isExpired() const {
    return getAge() > timeoutMs;
}

int64_t Message::getAge() const {
    return getCurrentTimestampMs() - timestamp;
}

} // namespace AcademiaBridge
