# Cross-Platform Message Bridge - Usage Guide

## Overview

You now have a robust bidirectional message bridge with:
- ✅ **Cross-platform** - Works on macOS (WKWebView), ready for Windows (WebView2)
- ✅ **Bidirectional** - Native ↔ JavaScript, both sides can initiate requests
- ✅ **Type-safe** - Full TypeScript types + C++ interfaces
- ✅ **High-performance** - Priority queue, message batching, async processing
- ✅ **Multi-client** - Support unlimited popups with central routing
- ✅ **State sync** - Reactive state management across all clients
- ✅ **Robust** - Timeouts, error handling, message queueing

## Architecture

```
┌─────────────────────────────────────────┐
│  Native (C++/Objective-C++)             │
│                                         │
│  MessageRouter (Central Hub)            │
│  ├─ Routes messages between clients    │
│  ├─ Manages request-response tracking  │
│  ├─ Priority queue processing           │
│  └─ State synchronization               │
│         ↕                                │
│  MacOSWebViewBridge (per popup)         │
│  ├─ WKWebView management                │
│  ├─ JavaScript injection                │
│  └─ Message serialization               │
└─────────────────────────────────────────┘
                ↕
┌─────────────────────────────────────────┐
│  JavaScript/TypeScript                  │
│                                         │
│  MessageBridge (messageBridge.ts)       │
│  ├─ Platform detection                  │
│  ├─ Promise-based API                   │
│  ├─ Handler registration                │
│  └─ Message queueing                    │
└─────────────────────────────────────────┘
```

## Quick Start

### 1. Native Side (C++/Objective-C++)

#### Creating a Bridge Instance

```cpp
#include "bridge/factory/BridgeFactory.h"
#include "bridge/interface/MessageRouter.h"

using namespace AcademiaBridge;

// Create bridge for a popup
auto bridge = BridgeFactory::createBridge();
bridge->setClientId("popup-1");
bridge->initialize();

// Register with router
MessageRouter::getInstance().registerClient("popup-1", bridge);

// Load HTML content
bridge->loadHTML("/path/to/popup/index.html");
bridge->showWindow();
```

#### Sending Messages to JavaScript

```cpp
// Fire-and-forget event
Message msg;
msg.id = "msg-123";
msg.from = "native";
msg.to = "popup-1";
msg.type = MessageType::EVENT;
msg.action = "updateContent";
msg.payload = "{\"text\":\"Hello from native!\"}";

bridge->sendMessage(msg);
```

#### Request-Response Pattern (Native → JS)

```cpp
// Send request and handle response
Message request;
request.id = "req-456";
request.from = "native";
request.to = "popup-1";
request.type = MessageType::REQUEST;
request.action = "getSelectedText";
request.payload = "null";
request.timeoutMs = 5000;

bridge->sendMessageAsync(request, [](const Message& response) {
    if (response.type == MessageType::ERROR) {
        std::cerr << "Request failed: " << response.payload << std::endl;
    } else {
        std::cout << "Got response: " << response.payload << std::endl;
    }
});
```

#### Receiving Messages from JavaScript

```cpp
// Register handler for specific action
bridge->registerHandler("buttonClick", [](const Message& msg) {
    std::cout << "Button clicked with payload: " << msg.payload << std::endl;

    // Extract data from JSON payload
    // Process...
});
```

#### Using the Router for Multi-Client Communication

```cpp
// Broadcast to all clients
Message broadcast;
broadcast.from = "native";
broadcast.to = "*";
broadcast.type = MessageType::EVENT;
broadcast.action = "themeChanged";
broadcast.payload = "{\"theme\":\"dark\"}";

MessageRouter::getInstance().broadcast(broadcast);

// Target specific pattern (all popups)
MessageRouter::getInstance().broadcast(broadcast, "popup-*");

// Sync state across all clients
MessageRouter::getInstance().syncState("currentUser", "{\"name\":\"John\",\"id\":123}");
```

### 2. JavaScript/TypeScript Side

#### Initialization

```typescript
import MessageBridge from './messageBridge';

// Create bridge instance
const bridge = new MessageBridge('popup-1');

// Check connection
if (bridge.isConnected()) {
    console.log('Bridge ready!');
}
```

#### Sending Events to Native

```typescript
// Fire-and-forget event
bridge.sendEvent('native', 'buttonClick', {
    action: 'lookup',
    text: 'selected text here'
});
```

#### Request-Response Pattern (JS → Native)

```typescript
// Send request and await response
try {
    const result = await bridge.sendRequest(
        'native',
        'searchFiles',
        { query: 'academia' },
        5000 // timeout
    );

    console.log('Search results:', result);
} catch (error) {
    console.error('Request failed:', error);
}
```

#### Receiving Messages from Native

```typescript
// Register handler for events
bridge.on('updateContent', (msg) => {
    console.log('Content update:', msg.payload);
    // Update UI...
});

// Handler for requests (automatically sends response)
bridge.on('getSelectedText', async (msg) => {
    // Return value becomes the response payload
    return {
        text: 'currently selected text',
        length: 123
    };
});

// Handler for state updates
bridge.on('stateUpdate', (msg) => {
    const { key, value } = msg.payload;
    console.log(`State changed: ${key} =`, value);
});
```

### 3. React Integration

```typescript
import { useState, useEffect } from 'react';
import MessageBridge from './messageBridge';

// Create bridge instance (singleton)
const bridge = new MessageBridge('popup-1');

function Popup() {
    const [text, setText] = useState('');

    useEffect(() => {
        // Register handler
        bridge.on('updateContent', (msg) => {
            setText(msg.payload.text);
        });

        return () => {
            bridge.off('updateContent');
        };
    }, []);

    const handleButtonClick = async (action: string) => {
        try {
            const result = await bridge.sendRequest('native', action, { text });
            console.log('Result:', result);
        } catch (error) {
            console.error('Failed:', error);
        }
    };

    return (
        <div>
            <div>{text}</div>
            <button onClick={() => handleButtonClick('lookup')}>
                Lookup
            </button>
        </div>
    );
}
```

## Advanced Usage

### Custom Priority Messages

```cpp
Message urgent;
urgent.priority = Priority::HIGH;
urgent.action = "criticalUpdate";
// High priority messages are processed first
```

### State Synchronization

```typescript
// Native side - sync state
MessageRouter::getInstance().syncState("selection", jsonString);

// JS side - receive updates
bridge.on('stateUpdate', (msg) => {
    const { key, value } = msg.payload;
    if (key === 'selection') {
        // Update local state
    }
});
```

### Multiple Popups

```cpp
// Create multiple bridges
for (int i = 0; i < 3; i++) {
    auto bridge = BridgeFactory::createBridge();
    std::string clientId = "popup-" + std::to_string(i);
    bridge->setClientId(clientId);
    bridge->initialize();

    MessageRouter::getInstance().registerClient(clientId, bridge);
}

// Send to all popups
MessageRouter::getInstance().broadcast(msg, "popup-*");

// Send to specific popup
MessageRouter::getInstance().routeMessage(msgToPopup2);
```

### Error Handling

```typescript
// Timeout handling
try {
    const result = await bridge.sendRequest('native', 'slowOperation', null, 10000);
} catch (error) {
    if (error.message.includes('timeout')) {
        console.error('Operation timed out');
    }
}

// Error responses
bridge.on('criticalAction', async (msg) => {
    if (!isValid(msg.payload)) {
        throw new Error('Invalid payload');
        // Bridge automatically sends error response
    }
    return { success: true };
});
```

## Migration from Old System

### Before (Old System)

```typescript
// Old: Direct WKWebView message passing
window.webkit?.messageHandlers?.buttonClick.postMessage({ action, text });

// Old: Manual update function
window.updateContent = (text) => {
    setText(text);
};
```

### After (New System)

```typescript
// New: Type-safe bridge with error handling
await bridge.sendRequest('native', 'buttonClick', { action, text });

// New: Registered handler with response capability
bridge.on('updateContent', async (msg) => {
    setText(msg.payload.text);
    return { received: true }; // Optional response
});
```

## Performance Tips

1. **Use events for fire-and-forget**: Don't use requests if you don't need a response
2. **Batch state updates**: Use state sync for related values
3. **Set appropriate timeouts**: Short for UI interactions, long for backend operations
4. **Use priorities**: Mark user interactions as HIGH priority
5. **Clean up handlers**: Unregister handlers when components unmount

## Next Steps

To integrate with your existing code:

1. **Update popup/index.tsx** to use MessageBridge instead of window.updateContent
2. **Update bridge.mm** to create bridges via BridgeFactory
3. **Replace direct WKWebView calls** with bridge.sendMessage()
4. **Migrate button handlers** to use the new message system
5. **Add main thread bridge** for main window ↔ popup communication

## Troubleshooting

### "Bridge not ready" warnings
- Wait for `bridge.isConnected()` to return true
- Messages are automatically queued until ready

### "No handler for action" warnings
- Make sure handlers are registered before messages arrive
- Check action names match exactly

### Timeouts
- Increase timeout for slow operations
- Check that response handlers are registered
- Verify bridge is initialized on both sides

## Architecture Benefits

✅ **Eliminates race conditions** - Proper initialization handshake
✅ **Type safety** - TypeScript + C++ type checking
✅ **Scalable** - Add unlimited clients without code changes
✅ **Testable** - Mock bridges for unit tests
✅ **Observable** - All messages logged through central router
✅ **Cross-platform ready** - Abstract interface for platform implementations
