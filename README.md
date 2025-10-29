# Academia Electron

A desktop application for uploading and managing PDF files on Academia.edu.

## Overview

Academia Electron is an Electron-based desktop application that provides a user-friendly interface for bulk uploading PDF files to Academia.edu and searching through uploaded papers. The application handles authentication, extracts PDF metadata, and manages file uploads with real-time progress tracking.

## Features

- **User Authentication**: Secure login to Academia.edu with session persistence
- **Bulk PDF Upload**: Select a folder and upload all PDF files recursively
- **Smart Title Extraction**: Automatically extracts and normalizes PDF titles from metadata
- **Search Functionality**: Search through your uploaded papers by title
- **Real-time Progress**: Visual feedback during upload operations
- **Cookie-based Sessions**: Persistent authentication using secure cookie storage

## Prerequisites

- Node.js 14+ and npm
- An Academia.edu account

## Installation

1. Clone the repository:
   ```bash
   cd academia-electron
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Development

### Running the Application

Start the application in development mode:

```bash
npm start
```

This will launch the Electron app with hot-reloading enabled.

### Development Tools

To enable Chrome DevTools, uncomment line 26 in `main.js`:

```javascript
mainWindow.webContents.openDevTools();
```

## Building

### Package the Application

Create a distributable package:

```bash
npm run package
```

### Create Installers

Generate platform-specific installers:

```bash
npm run make
```

Supported platforms:
- **macOS**: ZIP archive
- **Windows**: Squirrel installer
- **Linux**: DEB and RPM packages

## Project Structure

```
academia-electron/
├── src/
│   ├── main.ts              # Main Electron process
│   ├── preload.ts           # Preload script for IPC communication
│   ├── renderer.js          # Frontend logic
│   ├── uploader.ts          # Academia.edu API client
│   ├── syncService.ts       # File synchronization service
│   ├── native/              # Native C++/Objective-C++ modules
│   │   ├── bridge.mm        # Word accessibility integration
│   │   └── bridge/          # Cross-platform message bridge
│   │       ├── interface/   # Platform-agnostic interfaces
│   │       │   ├── Message.h/cpp
│   │       │   ├── IWebViewBridge.h
│   │       │   └── MessageRouter.h/cpp
│   │       ├── macos/       # macOS-specific implementation
│   │       │   └── MacOSWebViewBridge.h/mm
│   │       ├── windows/     # Windows-specific (future)
│   │       └── factory/     # Bridge factory
│   │           └── BridgeFactory.h/cpp
│   └── popup/               # Popup window UI
│       ├── Popup.tsx        # React popup component
│       ├── index.tsx        # Popup entry point
│       ├── messageBridge.ts # TypeScript bridge client
│       └── hooks/           # React hooks for bridge
│           └── useBridge.ts
├── forge.config.js          # Electron Forge configuration
└── package.json             # Project dependencies
```

### Key Components

- **main.ts**: Electron main process that creates windows and handles IPC communication
- **uploader.ts**: Core API client for Academia.edu operations (login, upload, search)
- **preload.ts**: Secure bridge between renderer and main processes
- **syncService.ts**: Watches folders and syncs files to backend
- **bridge.mm**: Native module for MS Word accessibility and text selection tracking
- **bridge/**: Cross-platform message bridge for native ↔ JavaScript communication
- **popup/**: React-based popup UI for selected text actions

## Usage

1. **Login**: On first launch, you'll be prompted to log in with your Academia.edu credentials
2. **Select Folder**: Click "Choose Folder" to select a directory containing PDF files
3. **Upload**: The app will automatically upload all PDF files found in the selected folder
4. **Search**: Use the search bar to find papers by title

## Configuration

### Custom API URL

Set a custom Academia.edu API endpoint:

```bash
export ACADEMIA_API_URL=https://your-custom-api.academia.edu/
```

The default is `https://api.academia.edu/`.

## Security Features

This application implements modern Electron security best practices:

- **Context Isolation**: Enabled to prevent renderer process from accessing Node.js/Electron APIs directly
- **No Node Integration**: Disabled in renderer process
- **Preload Script**: Secure IPC communication through exposed APIs only
- **Cookie Encryption**: Enabled via Electron Fuses
- **ASAR Integrity Validation**: Prevents tampering with packaged code

## Data Storage

- **Cookies**: Stored in the user's application data directory (`userData/backendCookies.json`)
- **Session Persistence**: Login sessions persist across app restarts

## Dependencies

### Core
- **electron**: Cross-platform desktop framework
- **axios**: HTTP client for API requests
- **tough-cookie**: Cookie parsing and storage
- **pdf-lib**: PDF metadata extraction

### Development
- **@electron-forge**: Build and packaging tools
- **@electron/fuses**: Security configuration

## Message Bridge Architecture

This application includes a sophisticated cross-platform message bridge for bidirectional communication between native code (C++/Objective-C++) and JavaScript/TypeScript.

### Architecture Overview

```
┌─────────────────────────────────────┐
│  Native Layer (C++/Objective-C++)   │
│  ┌───────────────────────────────┐  │
│  │  MessageRouter                │  │
│  │  • Multi-client routing       │  │
│  │  • Priority queue             │  │
│  │  • State synchronization      │  │
│  │  • Request-response tracking  │  │
│  └───────────────────────────────┘  │
│           ↕                          │
│  ┌───────────────────────────────┐  │
│  │  MacOSWebViewBridge           │  │
│  │  • WKWebView management       │  │
│  │  • JavaScript injection       │  │
│  │  • Message serialization      │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
              ↕
┌─────────────────────────────────────┐
│  JavaScript/TypeScript Layer        │
│  ┌───────────────────────────────┐  │
│  │  MessageBridge                │  │
│  │  • Platform detection         │  │
│  │  • Promise-based API          │  │
│  │  • Handler registration       │  │
│  │  • Message queueing           │  │
│  └───────────────────────────────┘  │
│           ↕                          │
│  ┌───────────────────────────────┐  │
│  │  React Hooks                  │  │
│  │  • useNativeEvent             │  │
│  │  • useSendMessage             │  │
│  │  • useNativeState             │  │
│  │  • useNativeRequest           │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

### Features

- ✅ **Bidirectional Communication**: Both native and JS can initiate requests
- ✅ **Type-Safe**: Full TypeScript types + C++ interfaces
- ✅ **Promise-Based**: Clean async/await syntax
- ✅ **Multi-Client**: Support for multiple popup windows with centralized routing
- ✅ **State Sync**: Broadcast state changes to all clients
- ✅ **High Performance**: Priority queue, message batching, background processing
- ✅ **Cross-Platform Ready**: Abstract interface for Windows (WebView2) implementation
- ✅ **Robust**: Timeouts, error handling, automatic message queueing

### Quick Start - JavaScript Side

```typescript
import { useSendMessage, useNativeEvent } from './hooks/useBridge';

function MyComponent() {
  const { sendRequest, loading } = useSendMessage();

  // Listen for events from native
  useNativeEvent('updateContent', (msg) => {
    console.log('Received:', msg.payload);
  });

  // Send request to native
  const handleClick = async () => {
    const result = await sendRequest('buttonClick', {
      action: 'lookup',
      text: 'selected text'
    });
    console.log('Result:', result);
  };

  return <button onClick={handleClick}>Click Me</button>;
}
```

### Quick Start - Native Side

```cpp
#include "bridge/factory/BridgeFactory.h"
#include "bridge/interface/MessageRouter.h"

using namespace AcademiaBridge;

// Create and register bridge
auto bridge = BridgeFactory::createBridge();
bridge->setClientId("popup-1");
bridge->initialize();

MessageRouter::getInstance().registerClient("popup-1", bridge);

// Send message to JavaScript
Message msg;
msg.from = "native";
msg.to = "popup-1";
msg.type = MessageType::EVENT;
msg.action = "updateContent";
msg.payload = "{\"text\":\"Hello from native!\"}";

bridge->sendMessage(msg);

// Register handler for messages from JavaScript
bridge->registerHandler("buttonClick", [](const Message& msg) {
    std::cout << "Button clicked: " << msg.payload << std::endl;
});
```

### React Hooks API

#### `useNativeEvent(action, handler)`
Listen for events from native code with automatic cleanup.

```typescript
useNativeEvent('updateContent', (msg) => {
  setText(msg.payload.text);
});
```

#### `useSendMessage()`
Send events and requests to native with loading/error states.

```typescript
const { sendEvent, sendRequest, loading, error } = useSendMessage();

// Fire-and-forget
sendEvent('buttonClick', { action: 'copy' });

// Request-response
const result = await sendRequest('searchFiles', { query: 'test' });
```

#### `useNativeState(key, initialValue, syncToNative)`
Bidirectionally synced state between JS and native.

```typescript
const [text, setText] = useNativeState('selectedText', '');
// Updates from native automatically update local state
```

#### `useNativeRequest(action, payload, options)`
Make a request with built-in loading/error handling.

```typescript
const { data, loading, error, refetch } = useNativeRequest('getUser', { id: 123 });

if (loading) return <Spinner />;
if (error) return <Error message={error.message} />;
return <div>{data.name}</div>;
```

#### `useNativeCallback(action, payloadMapper, options)`
Create callbacks that send requests to native.

```typescript
const handleClick = useNativeCallback('buttonClick', (text) => ({
  action: 'lookup',
  text
}));

<button onClick={() => handleClick(selectedText)}>Lookup</button>
```

### Building Native Code

```bash
# Build native bridge module
npm run build:native

# Or manually
cd src/native
npx node-gyp rebuild
```

### Message Types

- **EVENT**: Fire-and-forget notifications
- **REQUEST**: Expects a response
- **RESPONSE**: Response to a request
- **STATE_UPDATE**: State synchronization
- **ERROR**: Error message

### Platform Support

- **macOS**: ✅ Fully implemented (WKWebView)
- **Windows**: 🚧 Ready for implementation (WebView2)
- **Linux**: 🚧 Future (WebKitGTK)

### Advanced Usage

See [BRIDGE_USAGE.md](./BRIDGE_USAGE.md) for comprehensive documentation including:
- Multi-client communication patterns
- State synchronization
- Error handling
- Performance optimization
- Migration guides

## Why Native WebView vs Electron BrowserWindow

This application uses **native WKWebView (macOS)** instead of Electron BrowserWindow for the Word integration popups. This is an **architectural necessity**, not a preference.

### The Critical Requirement

The application displays interactive popups (`TextPopupWindow`, `ClickPopupWindow`) over Microsoft Word when text is selected. These popups must:
- Display React-based UI with buttons and suggestions
- Respond to mouse clicks and hover events
- **Never steal focus from Word** - users must continue typing seamlessly

### Why Electron BrowserWindow Cannot Work

Electron windows have a fundamental limitation for this use case:

| Feature | Native WKWebView + NSPanel | Electron BrowserWindow |
|---------|---------------------------|------------------------|
| **Non-Activating Behavior** | ✅ Interactive without stealing focus | ❌ Always activates on interaction |
| **Focus Management** | ✅ `NSPanel` with `becomesKeyOnlyIfNeeded` | ❌ Either activates or ignores all input |
| **Window Level Control** | ✅ `NSFloatingWindowLevel` - precise z-order | ⚠️ Limited floating capabilities |
| **Memory Footprint** | ✅ 10-20MB per popup | ❌ 100MB+ per window |
| **Startup Time** | ✅ <100ms | ⚠️ ~500ms+ |
| **Multiple Popups** | ✅ Can spawn 5-10 simultaneously | ❌ Memory prohibitive |

**The Dealbreaker**: Electron BrowserWindow either steals focus (interrupts typing) or ignores mouse events (unusable UI). There's no middle ground for non-activating interactive windows.

### Technical Requirements Only Native APIs Fulfill

1. **Non-Activating Popups** ⭐⭐⭐
   - `NSPanel` with `NSWindowStyleMaskNonactivatingPanel` style
   - `floatingPanel = YES` and `becomesKeyOnlyIfNeeded = NO`
   - Essential for uninterrupted Word workflow

2. **True Floating Windows** ⭐⭐⭐
   - `NSFloatingWindowLevel + 1` - stays above Word, below system UI
   - Works with Spaces, Mission Control, multi-monitor setups
   - Electron cannot reliably float over other applications

3. **Lightweight Resource Usage** ⭐⭐
   - Multiple concurrent popups (5-10 for citations)
   - Native: 10-20MB each → 50-100MB total ✅
   - Electron: 100MB each → 500-1000MB total ❌

4. **Pixel-Perfect Positioning** ⭐⭐
   - Accessibility API returns bounds in native screen coordinates
   - `NSPanel` positioning matches exactly
   - Electron has coordinate system conversion issues

### The Hybrid Approach

Our architecture leverages each technology's strengths:

- **Native WKWebView**: Word integration popups (critical UX)
  - Non-activating behavior
  - Lightweight and fast
  - Platform-specific but necessary

- **Electron BrowserWindow**: Dev/admin window
  - Full development experience
  - DevTools integration
  - Hidden in production

- **Tray Icon**: Primary UI in production
  - Minimal footprint
  - Always accessible

### User Experience Impact

Without native webview, **every popup interaction would interrupt typing in Word**. This would make the application frustrating and unusable for its core purpose. The native implementation ensures:
- Seamless text selection → popup workflow
- No disruption to writing process
- Professional, native macOS integration

### Conclusion

The native WKWebView implementation is **essential and irreplaceable**. The complexity of maintaining native code (Objective-C++, platform-specific builds, Accessibility API integration) is justified because it enables the fundamental user experience that makes this application viable.

## Known Issues & TODOs

- Windows bridge implementation (WebView2) needs to be completed
- jQuery is loaded from CDN (see index.html:121) - should be packaged locally
- Styles are inline (see index.html:8) - should be moved to SCSS

## License

UNLICENSED

## Author

Academia.edu
