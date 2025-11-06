# Academia Electron - Architecture Documentation

> **Quick Reference for Developers and AI Agents**
> This document provides a high-level overview of the system architecture to help you quickly understand how components relate and where to implement new features.

## Table of Contents

- [Overview](#overview)
- [Component Overview](#component-overview)
- [Detailed Components](#detailed-components)
- [Communication Patterns](#communication-patterns)
- [Data Flow Examples](#data-flow-examples)
- [Key IPC Channels Reference](#key-ipc-channels-reference)
- [Quick Start for Developers](#quick-start-for-developers)
- [Related Documentation](#related-documentation)

---

## Overview

Academia Electron is a macOS desktop application that integrates with Microsoft Word to provide Academia.edu features including paper search, file synchronization, notifications, and AI-powered writing assistance. The application uses a sophisticated multi-layer architecture combining Electron IPC, native Objective-C++ bridges, WKWebView-based overlays, and a local HTTP server.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                              │
│  ┌──────────────────┐              ┌──────────────────┐         │
│  │  Main Process    │◄────IPC─────►│ Renderer Process │         │
│  │   (src/main.ts)  │              │ (src/renderer/)  │         │
│  └────────┬─────────┘              └──────────────────┘         │
│           │                                                       │
│           │ N-API                                                │
│           ▼                                                       │
│  ┌────────────────────────────────────────────────┐             │
│  │        Native Bridge (Objective-C++)           │             │
│  │  ┌─────────────────────────────────────────┐   │             │
│  │  │  WordAccessibilityObserver (bridge.mm)  │   │             │
│  │  └──────────────┬──────────────────────────┘   │             │
│  │                 │                                │             │
│  │                 ▼                                │             │
│  │  ┌─────────────────────────────────────────┐   │             │
│  │  │  MicrosoftWordAdapter                   │   │             │
│  │  │  (Tracks Word window, scroll, position) │   │             │
│  │  └──────────────┬──────────────────────────┘   │             │
│  │                 │                                │             │
│  │                 ▼                                │             │
│  │  ┌─────────────────────────────────────────┐   │             │
│  │  │  AcademiaManager                        │   │             │
│  │  │  (Coordinates overlays, distributes)    │   │             │
│  │  └──────────────┬──────────────────────────┘   │             │
│  │                 │                                │             │
│  │                 ▼                                │             │
│  │  ┌─────────────────────────────────────────┐   │             │
│  │  │  Overlay Windows (NSPanel + WKWebView)  │   │             │
│  │  │  - NotificationsButton                  │   │             │
│  │  │  - NotificationsPopup                   │   │             │
│  │  │  - OverallReviewButton/Popup            │   │             │
│  │  │  - TextSideButton/Popup                 │   │             │
│  │  └─────────────────────────────────────────┘   │             │
│  └────────────────────────────────────────────────┘             │
│           ▲                                                       │
│           │ HTTP Requests (fetch)                                │
│           │                                                       │
│  ┌────────┴─────────┐                                            │
│  │   HTTP Server    │                                            │
│  │ (Fastify - :23111)│                                           │
│  └──────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
                       │
                       │ Academia.edu API
                       ▼
              [ Academia.edu Backend ]
```

### Key Technologies

- **Electron**: Cross-platform desktop framework
- **React**: UI components (renderer and popups)
- **TypeScript**: Type-safe development
- **Objective-C++**: Native macOS integration
- **WKWebView**: Native webview for overlay windows
- **Fastify**: High-performance HTTP server
- **macOS Accessibility API**: Word integration

---

## Component Overview

| Component | Location | Primary Responsibility | Key Files |
|-----------|----------|----------------------|-----------|
| **Electron Main Process** | `src/main.ts` | App lifecycle, IPC handlers, service coordination | `main.ts` (1805 lines) |
| **HTTP Server** | `src/server/` | Local REST API for overlays, proxy to Academia.edu | `httpServer.ts`, `routes/*.ts` |
| **Electron Renderer** | `src/renderer/` | Development UI and Projects management | `App.tsx`, `components/*.tsx` |
| **Native Bridge** | `src/native/bridge/` | Multi-layer Word integration architecture | `bridge.mm`, `adapters/*.mm`, `managers/*.mm`, `windows/*.mm` |
| **Native MS Word Adapter** | `src/native/wordAccessibility.ts`<br>`src/native/bridge/adapters/` | Tracks Word state, detects scrolling, position tracking | `wordAccessibility.ts`, `MicrosoftWordAdapter.mm` |
| **Native Academia Manager** | `src/native/bridge/managers/` | Coordinates overlay windows, distributes updates | `AcademiaManager.mm` |
| **Native Webview Popups** | `src/popup/` | React-based overlay UI with message bridge | `messageBridge.ts`, `*.tsx`, `*.html` |

---

## Detailed Components

### 1. Electron Main Process

**Location**: `src/main.ts` (1805 lines)

**Responsibilities**:
- Manages app lifecycle and window creation
- Provides 30+ IPC handlers for renderer communication
- Initializes and coordinates services:
  - `syncService` - Legacy file synchronization
  - `projectSyncService` - Project-based folder sync
  - `notificationManager` - Notification polling and delivery
  - `wordAccessibility` - Native Word tracking bridge
  - `httpServer` - Local HTTP API server
- Creates system tray icon with context menu
- Auto-starts Word tracking when MS Word launches

**Key IPC Handlers**:
- Authentication: `login`, `logout`, `check-login`, `get-current-user`
- Files: `upload-files`, `search-files`, `select-folder`, `scan-folder-for-files`
- Sync: `add-sync-folder`, `remove-sync-folder`, `get-sync-folders`, `sync-folder-now`
- Notifications: `get-notifications`, `mark-notification-read`, `start-notification-polling`
- Word: `get-word-text`, `start-selection-tracking`, `check-word-frontmost`
- Generic: `api-call` - Generic REST API proxy with CSRF token handling

**Communication**:
- **To Renderer**: `webContents.send()` for events (`new-notification`, `button-action`, `api-log`)
- **From Renderer**: `ipcMain.handle()` for request-response pattern
- **To Native**: Direct method calls on `wordAccessibility` singleton
- **Cleanup**: `app.on('before-quit')` stops all services and native observers

**Related Documentation**: Main entry point - see README.md for general overview

---

### 2. HTTP Server

**Location**: `src/server/httpServer.ts` (270 lines)

**Responsibilities**:
- Provides local REST API on `127.0.0.1:23111` (localhost only for security)
- Serves static popup UI files from `/dist/popup` at `/ui/popup/` route
- Proxies requests to Academia.edu API with automatic authentication
- Provides notification endpoints for overlay windows

**Key Endpoints**:

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/notifications` | GET | List notifications with filters (status, limit) |
| `/api/notifications/count` | GET | Get counts by status (unread, read, total) |
| `/api/notifications/:id` | PATCH | Update notification status |
| `/proxy-api/*` | ALL | Wildcard proxy to Academia.edu API with auth |
| `/api/health` | GET | Health check endpoint |

**Architecture Benefits**:
- Simplifies data fetching for overlays (HTTP is simpler than complex IPC)
- Automatic cookie-based authentication
- CSRF token injection for write operations
- High-performance Fastify framework

**Communication Pattern**:
```
WKWebView Overlay → HTTP GET/POST → Fastify Routes → notificationManager → Academia.edu API
                                                     ↓
                                         Return JSON response
```

**Related Documentation**: N/A (straightforward REST API)

---

### 3. Electron Renderer Process

**Location**: `src/renderer/App.tsx` (246 lines), `src/renderer/components/` (20+ components)

**Responsibilities**:
- **Development Tools UI**: Multi-page interface with sidebar navigation
  - Position Debugger
  - Uploader (file upload to Academia.edu)
  - Notifications viewer
  - Screen Reader (OCR-based)
  - Sync Agent
  - Word Reader
  - Selection Tracker
  - Tray Icon switcher
- **Projects UI**: Full project management interface (when `?window=main` query param)
  - Project list and detail views
  - Folder sync configuration
  - Collaborator management
  - File upload wizards

**Key Components**:
- `Projects.tsx` - Main project management UI
- `LoginModal.tsx` - Authentication modal
- `CustomTitleBar.tsx` - Custom window controls (frameless window)
- `SelectionTracker.tsx` - Displays Word selection events
- `SyncSection.tsx` - Folder sync management

**Communication Patterns**:
- **To Main**: `window.electronAPI.invoke()` - Request-response via preload script
- **From Main**: `window.electronAPI.on()` - Listen for events
- **Important Events**:
  - `new-notification` - New notification received
  - `button-action` - Native button clicked in Word
  - `selection-updated` - Text selected in Word
  - `api-log` - API request/response logging

**State Management**:
- React `useState` hooks for local state
- Listens to main process events for external updates
- Starts/stops notification polling based on login state

**Related Documentation**: N/A (standard React/Electron patterns)

---

### 4. Native Bridge

**Location**: `src/native/bridge/` (Multiple directories with 20+ files)

**Architecture Overview**:

The Native Bridge uses a multi-layer architecture for Microsoft Word integration:

```
WordAccessibilityObserver (bridge.mm) - Top-level coordinator
    ↓
MicrosoftWordAdapter (adapters/) - Word state tracking
    ↓
AcademiaManager (managers/) - Overlay coordination
    ↓
Overlay Windows (windows/) - NSPanel + WKWebView UI
```

#### Layer 1: WordAccessibilityObserver (`bridge.mm`)

**Responsibilities**:
- Top-level coordinator and N-API bindings for Node.js
- Creates and initializes all architecture components
- Manages AX (Accessibility) observer for Word process
- Handles system-level events (app activation, space changes)

**Key Features**:
- Monitors window move/resize notifications
- Detects macOS space/desktop changes
- Debug mode support (`DEBUG=1` environment variable)
- Provides N-API exports: `startObserving`, `stopObserving`, `checkPermission`, etc.

#### Layer 2: MicrosoftWordAdapter (`adapters/MicrosoftWordAdapter.mm`)

**Responsibilities**:
- Tracks Microsoft Word window position and bounds
- Detects scroll events including momentum scrolling
- Provides cached position data for performance
- Two-phase stability detection (polling + debouncing)

**Key Features**:
- **Position Tracking**: Word window bounds, scroll area, layout container
- **Scroll Detection**: Global event monitor + AX notifications
- **Debouncing**: 400ms scroll debounce, 500ms window move debounce
- **Caching**: 1-second cache validity for bounds
- **Delegate Pattern**: Notifies observers of state changes

**Delegate Methods**:
```objc
- (void)wordAdapter:(MicrosoftWordAdapter*)adapter didChangeState:(WordPositionState)state;
- (void)wordAdapter:(MicrosoftWordAdapter*)adapter didStartChanging:(BOOL)isChanging;
```

#### Layer 3: AcademiaManager (`managers/AcademiaManager.mm`)

**Responsibilities**:
- Central coordinator for all overlay windows
- Distributes Word state updates to registered overlays
- Manages badge counts across overlays
- Maintains weak reference registry to prevent retain cycles

**Key Features**:
- **Overlay Registry**: `NSHashTable` with weak references
- **Badge Management**: Centralized badge count updates (e.g., notification count)
- **Position Updates**: Recalculates overlay positions when Word state changes
- **Visibility Management**: Shows/hides all overlays based on Word state

**Integration Example**:
```objc
// Register overlay
[_academiaManager registerOverlay:_notificationsButton];

// Update badge (propagates to all badge-capable overlays)
[_academiaManager updateBadgeCount:5];
```

#### Layer 4: Overlay Windows (`windows/*.mm`)

**Base Class**: `BasePopupWindow.mm`
- NSPanel-based non-activating windows
- WKWebView for UI rendering
- Message bridge integration
- HTML loading from `dist/popup/`

**Overlay Types**:
1. `AcademiaNotificationsButton.mm` - Notification bell icon with badge
2. `AcademiaNotificationsPopup.mm` - Notification list dropdown
3. `OverallReviewButton.mm` - Overall review button
4. `OverallReviewPopup.mm` - Review content popup
5. `TextSideButton.mm` - Text-based side button
6. `TextSidePopup.mm` - Text side content popup
7. `DebugBorderWindow.mm` - Debug visualization (borders)
8. `DebugInfoOverlay.mm` - Debug info display

**Overlay Protocol**:
```objc
@protocol OverlayWindow
- (void)updatePositionWithWordState:(WordPositionState)state;
- (void)show;
- (void)hide;
- (BOOL)isVisible;
- (NSString*)overlayIdentifier;
@optional
- (void)updateBadgeCount:(NSInteger)count;
@end
```

**Related Documentation**: See [docs/BRIDGE_USAGE.md](./BRIDGE_USAGE.md) for comprehensive API documentation

---

### 5. Native MS Word Adapter

**Location**:
- TypeScript wrapper: `src/native/wordAccessibility.ts` (374 lines)
- Native implementation: `src/native/bridge/adapters/MicrosoftWordAdapter.mm`

**Responsibilities**:
- Provides type-safe TypeScript wrapper around native Node.js addon
- Tracks Word window position, scroll state, and document layout
- Detects text selection changes
- Provides cached position data for performance

**Key Interfaces**:
```typescript
interface SelectionEvent {
  type: 'selectionChanged';
  text: string;
  x: number; y: number;
  width: number; height: number;
}

interface ScrollEvent {
  type: 'scrollStarted' | 'scrollEnded';
}

interface ButtonClickEvent {
  type: 'buttonClicked';
  text: string; // Action identifier
}
```

**API Methods**:
- `startObserving(pid, callback)` - Start tracking Word process
- `stopObserving()` - Stop tracking and clean up resources
- `checkPermission()` - Check macOS Accessibility permission
- `setServerBaseUrl(url)` - Set HTTP server URL for overlays
- `getSelectedText()` - Get current selection with coordinates
- `getWordWindowBounds()` - Get Word window position
- `getDocumentTopLeftCorner()` - Get document layout corner
- `getScrollAreaBounds()` - Get scroll area bounds
- `getButtonStates()` - Get overlay button positions

**Native Module Loading**:
- Uses `__non_webpack_require__` to bypass webpack
- Tries multiple paths (dev, packaged)
- Loads from `build/Release/word_accessibility.node`

**Related Documentation**: See [docs/AGENTS.md](./AGENTS.md) for troubleshooting and cleanup procedures

---

### 6. Native Academia Manager

**Location**: `src/native/bridge/managers/AcademiaManager.mm`

**Responsibilities**:
- Acts as central coordinator for all overlay windows
- Distributes Word state updates from MicrosoftWordAdapter to all registered overlays
- Manages badge counts across overlays
- Maintains weak reference registry to prevent memory leaks

**Architecture Pattern**:

```
MicrosoftWordAdapter (state change)
    ↓
AcademiaManager.didChangeState()
    ↓
For each registered overlay:
    overlay.updatePositionWithWordState(state)
```

**Key Methods**:
```objc
// Overlay lifecycle
- (void)registerOverlay:(id<OverlayWindow>)overlay;
- (void)unregisterOverlay:(id<OverlayWindow>)overlay;

// State distribution
- (void)updateAllOverlaysWithState:(WordPositionState)state;
- (void)showAllOverlays;
- (void)hideAllOverlays;

// Badge management
- (void)updateBadgeCount:(NSInteger)count;
```

**Registry Pattern**:
- Uses `NSHashTable` with `NSPointerFunctionsWeakMemory`
- Automatically removes deallocated overlays
- No retain cycles - overlays can be deallocated independently

**Related Documentation**: See [docs/BRIDGE_USAGE.md](./BRIDGE_USAGE.md) for integration patterns

---

### 7. Native Webview-based Popups

**Location**: `src/popup/` (React components, HTML, message bridge)

**Architecture**:

The popups use a three-layer architecture:

```
React Component (TypeScript)
    ↓
MessageBridge (messageBridge.ts)
    ↓
window.webkit.messageHandlers.bridge (macOS WKWebView)
    ↓
WKScriptMessageHandler (Objective-C++)
    ↓
Native Bridge (bridge.mm)
```

#### Message Bridge (`messageBridge.ts` - 546 lines)

**Responsibilities**:
- Bidirectional communication between JavaScript and native code
- Cross-platform support (macOS WKWebView, Windows WebView2)
- Promise-based request-response pattern
- Event system with handler registration

**Key Features**:
- **Platform Detection**: Auto-detects WKWebView vs WebView2
- **Message Queue**: Queues messages until bridge is ready
- **Pending Request Tracking**: Maps request IDs to promises
- **Hot Reload Support**: Transfers pending requests on instance replacement
- **WAGENT-68 Fix**: Pre-load queue processing to prevent race conditions

**Message Types**:
```typescript
type MessageType = 'request' | 'response' | 'event' | 'state-update' | 'error';

interface Message {
  id: string;
  from: string; // 'popup-1', 'native'
  to: string;
  type: MessageType;
  action: string; // 'getNotifications', 'updateContent'
  payload: any;
  timestamp: number;
  timeoutMs?: number;
}
```

**API Examples**:
```typescript
// Send event (fire-and-forget)
bridge.sendEvent('native', 'buttonClick', { action: 'lookup', text: '...' });

// Send request (promise-based)
const result = await bridge.sendRequest('native', 'getNotifications', null, 5000);

// Register handler
bridge.on('updateContent', (msg) => { /* ... */ });
```

#### React Components

**Popup Components**:
- `AcademiaNotificationsButton.tsx` - Notification bell icon
- `AcademiaNotificationsPopup.tsx` - Notification list
- `OverallReviewButton.tsx` - Review button
- `OverallReviewPopup.tsx` - Review content
- `TextSideButton.tsx` - Text-based button
- `TextSidePopup.tsx` - Text content

**Hook**: `useBridge.ts` - Custom React hook for message bridge integration

#### HTML Structure

Each popup has its own HTML file that serves as a Webpack entry point:
- `academia-notifications-button.html`
- `academia-notifications-popup.html`
- `overall-review-button.html`
- `overall-review-popup.html`
- `text-side-button.html`
- `text-side-popup.html`

**HTML Features**:
- Minimal HTML shell for React mounting
- Webpack creates separate bundles per popup
- Bridge script injected by native code
- Uses HTTP server for data fetching

**Related Documentation**: See [docs/BRIDGE_USAGE.md](./BRIDGE_USAGE.md) for comprehensive message bridge documentation

---

## Communication Patterns

### 1. Electron IPC (Main ↔ Renderer)

```
Renderer Process:
    window.electronAPI.invoke('login', email, password)
        ↓
Main Process:
    ipcMain.handle('login', async (event, email, password) => {
        // Handle login
        return { success: true, user: {...} };
    })
        ↓
Renderer Process:
    Returns promise with result
```

**Key Points**:
- Uses Electron's context bridge (`preload.ts`)
- Request-response pattern with promises
- Type-safe via TypeScript interfaces
- Bidirectional: Main can send events to renderer via `webContents.send()`

---

### 2. Native Bridge (Main ↔ Native C++)

```
Main Process:
    wordAccessibility.startObserving(pid, callback)
        ↓
Native Module (N-API):
    StartObserving() function in bridge.mm
        ↓
Objective-C++:
    Create AXObserver, set up notifications
        ↓
Callback:
    JS callback invoked with events via N-API
```

**Key Points**:
- Uses Node.js N-API for C++ ↔ JS bindings
- Event-driven architecture with callbacks
- Accessibility API for Word integration
- Cleanup required via `stopObserving()`

---

### 3. HTTP Server (Overlay ↔ Data)

```
WKWebView Overlay:
    fetch('http://127.0.0.1:23111/api/notifications')
        ↓
HTTP Server (Fastify):
    GET /api/notifications handler
        ↓
notificationManager:
    getNotificationsByStatus('unread')
        ↓
Return:
    JSON response with notification array
```

**Key Points**:
- Standard HTTP/REST patterns
- Localhost only (127.0.0.1) for security
- Automatic authentication via cookie jar
- Simpler than IPC for data fetching in overlays

---

### 4. Message Bridge (Overlay ↔ Native)

```
React Component:
    bridge.sendRequest('native', 'getUser')
        ↓
messageBridge.ts:
    window.webkit.messageHandlers.bridge.postMessage({
        id: 'req-123',
        from: 'popup-1',
        to: 'native',
        type: 'request',
        action: 'getUser',
        payload: null
    })
        ↓
WKScriptMessageHandler (Objective-C++):
    userContentController:didReceiveScriptMessage:
        ↓
Bridge Handler:
    Process request, fetch user data
        ↓
Send Response:
    [webView evaluateJavaScript:@"window.__bridgeReceive({...})"]
        ↓
messageBridge.ts:
    Resolve promise with response payload
```

**Key Points**:
- Bidirectional with request-response pattern
- Promise-based API for clean async/await
- Timeouts and error handling
- Cross-platform ready (WKWebView + WebView2)

---

### 5. Academia.edu API (Main ↔ Backend)

```
Main Process:
    const client = APIclient();
    const user = await client.get('/v0/user');
        ↓
uploader.ts (Axios):
    HTTP GET https://api.academia.edu/v0/user
    Headers: Cookie, CSRF-Token
        ↓
Academia.edu API:
    Process request, return user data
        ↓
Return:
    User object with profile info
```

**Key Points**:
- Cookie-based authentication
- CSRF tokens for write operations
- Axios with tough-cookie for cookie management
- Proxy available via HTTP server for overlays

---

## Data Flow Examples

### Example 1: User Selects Text in Word

```
1. User selects text in Microsoft Word
    ↓
2. Accessibility API fires kAXSelectedTextChangedNotification
    ↓
3. WordAccessibilityObserver receives notification (bridge.mm)
    ↓
4. MicrosoftWordAdapter processes selection
   - Gets selection text via AXUIElement
   - Gets selection bounds (x, y, width, height)
   - Checks scroll state
    ↓
5. AcademiaManager distributes to overlays
   - Calls updatePositionWithWordState() on each overlay
    ↓
6. TextSideButton updates position
   - Positions button relative to selection
   - Shows button with animation
    ↓
7. User clicks button in overlay
    ↓
8. WKWebView sends message via bridge
   - bridge.sendEvent('native', 'buttonClick', { action: 'lookup', text })
    ↓
9. Native code processes action
   - Could open popup, make API call, etc.
```

---

### Example 2: User Clicks Notification Icon

```
1. User clicks notification bell in overlay
    ↓
2. React component handles onClick
   - AcademiaNotificationsButton.tsx
    ↓
3. Component fetches notifications via HTTP
   - fetch('http://127.0.0.1:23111/api/notifications?status=unread')
    ↓
4. HTTP Server routes request
   - GET /api/notifications handler
    ↓
5. notificationManager fetches from database
   - getNotificationsByStatus('unread')
    ↓
6. Returns JSON response to overlay
    ↓
7. Overlay displays notification list
   - AcademiaNotificationsPopup.tsx renders list
    ↓
8. User clicks "Mark as Read"
    ↓
9. Component sends PATCH request
   - fetch('http://127.0.0.1:23111/api/notifications/123', {
       method: 'PATCH',
       body: JSON.stringify({ status: 'read' })
     })
    ↓
10. HTTP Server updates notification
    - PATCH /api/notifications/:id handler
    ↓
11. Returns updated notification
    ↓
12. Overlay updates UI
```

---

### Example 3: New Notification Arrives

```
1. notificationManager polls Academia.edu API
   - Every 60 seconds
    ↓
2. Detects new notification
    ↓
3. Saves to local database
    ↓
4. Emits event to main process
   - eventEmitter.emit('notification', notification)
    ↓
5. Main process sends to renderer
   - mainWindow.webContents.send('new-notification', notification)
    ↓
6. Main process updates badge count
   - wordAccessibility calls AcademiaManager.updateBadgeCount()
    ↓
7. AcademiaManager distributes to overlays
   - Calls updateBadgeCount() on registered overlays
    ↓
8. NotificationsButton updates badge
   - Shows red badge with count
    ↓
9. Renderer displays notification toast
   - Shows system notification or in-app toast
```

---

## Key IPC Channels Reference

### Authentication
- `check-login` → `{ loggedIn: boolean }`
- `login` → `{ success: boolean, user: User }`
- `logout` → `{ success: boolean }`
- `get-current-user` → `User | null`

### File Operations
- `select-folder` → `string | null` (folder path)
- `upload-files` → `void` (uses events for progress)
- `search-files` → `{ files: File[] }`
- `scan-folder-for-files` → `string[]` (file paths)

### Sync Management
- `get-sync-folders` → `SyncFolder[]`
- `add-sync-folder` → `{ success: boolean }`
- `remove-sync-folder` → `{ success: boolean }`
- `sync-folder-now` → `void`
- `get-folder-files` → `{ files: File[] }`

### Project Sync
- `start-project-folder-sync` → `{ success: boolean }`
- `stop-project-folder-sync` → `{ success: boolean }`
- `stop-project-sync` → `{ success: boolean }`

### Notifications
- `get-notifications` → `Notification[]`
- `start-notification-polling` → `void`
- `stop-notification-polling` → `void`
- `mark-notification-read` → `{ success: boolean }`
- `dismiss-notification` → `{ success: boolean }`

### Word Integration
- `get-word-text` → `{ text: string, wordCount: number }`
- `start-selection-tracking` → `{ success: boolean, error?: string }`
- `stop-selection-tracking` → `{ success: boolean }`
- `check-word-frontmost` → `boolean`
- `get-word-scroll-position` → `{ x: number, y: number }`

### Generic API
- `api-call` → `any` (generic REST API call)
  - Parameters: `{ method: 'GET' | 'POST' | 'PUT' | 'DELETE', endpoint: string, data?: any }`
  - Includes CSRF token for non-GET requests
  - Logs to renderer console via `api-log` event

### Events (Main → Renderer)
- `new-notification` - New notification received
- `button-action` - Native overlay button clicked
- `selection-updated` - Text selected in Word
- `api-log` - API request/response for debugging
- `file-uploaded` - File upload progress
- `folder-sync-status` - Sync status update

---

## Quick Start for Developers

### Adding a New IPC Handler

**Location**: `src/main.ts`

```typescript
// Add handler
ipcMain.handle('my-new-action', async (event, param1, param2) => {
  try {
    // Your logic here
    return { success: true, data: {...} };
  } catch (error) {
    console.error('Error:', error);
    return { success: false, error: error.message };
  }
});

// Add to preload.ts validChannels
const validChannels = [
  // ... existing channels
  'my-new-action'
];
```

---

### Adding a New Overlay Window

**Steps**:

1. **Create Native Window Class** (`src/native/bridge/windows/MyOverlay.mm`)
   ```objc
   @interface MyOverlay : BasePopupWindow <OverlayWindow>
   @end

   @implementation MyOverlay

   - (instancetype)initWithObserver:(id)observer {
       self = [super initWithHTMLFile:@"my-overlay.html" observer:observer];
       if (self) {
           // Custom initialization
       }
       return self;
   }

   - (void)updatePositionWithWordState:(WordPositionState)state {
       // Calculate position relative to Word window
       NSRect frame = NSMakeRect(state.bounds.x + 10, state.bounds.y + 10, 200, 50);
       [self.panel setFrame:frame display:YES];
   }

   @end
   ```

2. **Create React Component** (`src/popup/MyOverlay.tsx`)
   ```typescript
   import React from 'react';
   import MessageBridge from './messageBridge';

   const MyOverlay: React.FC = () => {
     const bridge = new MessageBridge('my-overlay');

     return (
       <div className="my-overlay">
         <button onClick={() => bridge.sendEvent('native', 'myAction', {})}>
           Click Me
         </button>
       </div>
     );
   };

   export default MyOverlay;
   ```

3. **Create HTML File** (`src/popup/my-overlay.html`)
   ```html
   <!DOCTYPE html>
   <html>
   <head>
       <meta charset="UTF-8">
       <title>My Overlay</title>
   </head>
   <body>
       <div id="root"></div>
       <script src="my-overlay.bundle.js"></script>
   </body>
   </html>
   ```

4. **Add Webpack Entry** (`webpack.popup.config.js`)
   ```javascript
   entry: {
     // ... existing entries
     'my-overlay': './src/popup/MyOverlay.tsx'
   }
   ```

5. **Register with AcademiaManager** (`src/native/bridge.mm`)
   ```objc
   MyOverlay* myOverlay = [[MyOverlay alloc] initWithObserver:self];
   [_academiaManager registerOverlay:myOverlay];
   ```

---

### Adding a New HTTP Endpoint

**Location**: `src/server/routes/` (create new file or add to existing)

```typescript
// src/server/routes/myroute.ts
import { FastifyInstance } from 'fastify';

export default async function myRoutes(fastify: FastifyInstance) {
  // GET endpoint
  fastify.get('/api/myendpoint', async (request, reply) => {
    return { data: 'Hello from my endpoint' };
  });

  // POST endpoint
  fastify.post('/api/myendpoint', async (request, reply) => {
    const body = request.body as { param: string };
    // Process...
    return { success: true };
  });
}

// Register in src/server/httpServer.ts
import myRoutes from './routes/myroute';
server.register(myRoutes);
```

---

### Debugging Tips

**Native Code**:
- Set `DEBUG=1` environment variable for verbose logging
- Check Console.app for native logs (search for app name)
- Use `NSLog(@"...")` for Objective-C logging
- Run native tests: `npm run test:native`

**Electron Main Process**:
- Logs appear in terminal where `npm start` was run
- Use `console.log` for debugging
- Check IPC handler responses

**Renderer Process**:
- Open DevTools: Uncomment `mainWindow.webContents.openDevTools()` in main.ts
- Use React DevTools browser extension
- Console logs appear in DevTools console

**Overlay Windows**:
- Enable WKWebView inspector: Right-click overlay → Inspect Element (if developer menu enabled)
- Check HTTP server requests: `curl http://127.0.0.1:23111/api/health`
- Use `console.log` in React components (visible in WKWebView inspector)

**Common Gotchas**:
- Native module changes require rebuild: `npm run build:native`
- Overlay HTML changes require webpack rebuild: `npm run build:popup`
- Always stop Word tracking before quitting to avoid zombie processes
- Accessibility permissions required for Word integration

---

## Related Documentation

### Detailed Documentation
- **[BRIDGE_USAGE.md](./BRIDGE_USAGE.md)** - Comprehensive message bridge API documentation
  - Cross-platform bridge architecture
  - Message types and patterns
  - Request-response examples
  - React hooks API
  - Multi-client communication
  - State synchronization

- **[AGENTS.md](./AGENTS.md)** - Native module architecture and troubleshooting
  - Native resource management
  - Proper shutdown procedures
  - Zombie process prevention
  - Cleanup scripts and testing
  - Common troubleshooting scenarios

### General Documentation
- **[README.md](../README.md)** - Project overview and getting started
  - Installation instructions
  - Development setup
  - Build and packaging
  - Security features
  - Why native WebView vs Electron BrowserWindow

### Test Documentation
- **[src/native/bridge/__tests__/README.md](../src/native/bridge/__tests__/README.md)** - Native unit tests
  - Test coverage
  - Running tests
  - Adding new tests
  - CI integration

---

## Architecture Principles

### 1. Separation of Concerns
- Clear boundaries between Electron, native code, and web UI
- Each component has single responsibility
- Minimal coupling between layers

### 2. Multiple Communication Channels
- **Electron IPC**: Main ↔ Renderer communication
- **HTTP API**: Data fetching for overlays (simpler than IPC)
- **Message Bridge**: Bidirectional overlay ↔ native communication
- **N-API**: Native C++ ↔ JavaScript bindings

### 3. Type Safety
- TypeScript throughout JavaScript/React code
- C++ interfaces in native code
- Clear message schemas for bridge communication

### 4. Performance
- Position caching (1-second validity)
- Scroll debouncing (400ms)
- Event coalescing
- Efficient AX API usage

### 5. Robustness
- Proper resource cleanup (timers, observers, windows)
- Error handling and timeouts
- Graceful degradation
- Signal handlers for clean shutdown

### 6. Developer Experience
- Hot reload support where possible
- Extensive logging and debug modes
- Clear error messages
- Comprehensive tests

---

## Summary

This architecture combines web technologies (Electron, React) with native platform capabilities (Accessibility API, WKWebView) to create a seamless Microsoft Word integration. The multi-layer design ensures clean separation of concerns while providing efficient communication paths between components.

**Key Strengths**:
- Type-safe and maintainable
- High performance with caching and debouncing
- Robust error handling and cleanup
- Extensible overlay system
- Cross-platform ready (macOS implemented, Windows prepared)

**When implementing new features**:
1. Identify which component(s) need changes
2. Follow existing patterns for that component
3. Add proper error handling and logging
4. Test with `DEBUG=1` for verbose output
5. Update documentation if adding new APIs

For questions or issues, refer to the detailed documentation linked above or check the component-specific README files.
