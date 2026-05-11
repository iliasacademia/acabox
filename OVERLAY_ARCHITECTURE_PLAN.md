# Overlay Architecture Simplification Plan

## Context

The cobuild overlay uses native macOS WKWebView (managed by Rust processes) floating on top of host apps like Microsoft Word. Because WKWebView lives outside Electron's process tree, it communicates with the Electron main process via HTTP to a local Fastify server on port 23111. This has grown into **three separate communication channels** (polling WebSocket, chat HTTP+SSE, bridge HTTP POST) with a **dual fanout problem** (same chat events delivered via both IPC for desktop and SSE for overlay). Additionally, the Rust processes have **zero automatic recovery** — if they crash, the overlay silently freezes.

**Goals:**
1. Simplify overlay-to-main communication into a single unified WebSocket
2. Add process supervision so the overlay recovers automatically from Rust process crashes

---

## Phase 1: Unified WebSocket Protocol

**What:** Collapse polling, chat streaming, and bridge commands into the existing WebSocket connection at `/ws/word/v4/focused`.

### 1A. Define the multiplexed protocol

Extend the existing WebSocket message format (currently only `{ type: "poll", data }` server→client and `{ type: "refresh" }` client→server):

**Server → Client:**
```
{ type: "poll", data: OverlayPollResponse }              // existing, unchanged
{ type: "chat:event", sessionId, data: ChatStreamMessage } // replaces SSE event frames
{ type: "chat:done", sessionId }                           // replaces SSE done frames
{ type: "chat:error", sessionId, error }                   // replaces SSE error frames
{ type: "bridge:ack", requestId, data }                    // optional bridge response
{ type: "heartbeat" }                                      // new: keepalive
```

**Client → Server:**
```
{ type: "refresh" }                                        // existing, unchanged
{ type: "chat:send", sessionId, text, documentPath?, selectedText? }  // replaces POST /send
{ type: "chat:subscribe", sessionId }                      // replaces GET /events SSE
{ type: "chat:unsubscribe", sessionId }                    // close session subscription
{ type: "bridge", action, payload, requestId? }            // replaces POST /bridge
```

**Files to update:**
- `src/popup/popupV2/shared.ts` — extend `WebSocketMessage` type union (line 129)

### 1B. Extract shared chat-send handler

The session creation + message sending logic is duplicated between:
- `POST /api/cobuilding/sessions/:id/send` (index.ts ~line 852)
- `ipcMain.on('chat:send', ...)` (index.ts ~line 2238)

Extract into a shared function in a new file:

**New file:** `src/cobuilding/main/chatSendHandler.ts`
```typescript
async function handleChatSend(params: {
  sessionId: string;
  text: string;
  documentPath?: string;
  selectedText?: string;
  onEvent: (msg: ChatStreamMessage) => void;
  onDone: () => void;
  onError: (err: string) => void;
}): Promise<void>
```

Both the IPC handler and the new WebSocket handler call this shared function. The only difference is delivery: IPC sends via `webContents.send()`, WebSocket sends via `ws.send()`.

**Files to modify:**
- `src/cobuilding/main/index.ts` — extract logic from lines ~852-979 and ~2238-2319

### 1C. Extend WebSocket route handler

Add chat and bridge message handling to the existing WebSocket route.

**File to modify:** `src/server/routes/websocket.ts`

Changes:
- Track per-client session subscriptions: `Map<WebSocket, Set<string>>`
- On `chat:send`: dispatch to shared `handleChatSend()`, stream events back via `ws.send()`
- On `chat:subscribe`: attach listener to agent session, forward events to this WebSocket client
- On `bridge`: dispatch to same action handler currently in `registerBridgeRoutes` (resolve `wid` server-side via `windowMonitorService.getFocusedWindowId()`)
- Server sends `{ type: "heartbeat" }` every 15s

**Dependencies:** Needs bridge action handler extracted from `src/server/routes/bridge.ts` into a callable function (not just a route handler).

### 1D. Remove SSE fanout infrastructure

Once chat events flow over the unified WebSocket:

**Remove from `src/cobuilding/main/index.ts`:**
- `sseSessionSubscribers` map (line 434)
- `sseFanoutListeners` map (line 435)
- `broadcastSseToSubscribers()` function (line 437)
- `ensureSseFanout()` function (line 451)
- `GET /api/cobuilding/sessions/:id/events` SSE endpoint (line ~758)

**Keep:**
- `ensureForwarding()` (line 490) — desktop IPC path stays unchanged
- `chat:foreign-done` IPC event (lines 469, 482) — desktop renderer still needs cross-surface sync
- HTTP endpoints as deprecated fallbacks for one release cycle

### 1E. Update overlay client

**Files to modify:**

1. `src/popup/popupV2/useWordPollWebSocket.ts` — extend to:
   - Accept chat events (`chat:event`, `chat:done`, `chat:error`) and dispatch to session-specific callbacks
   - Expose `sendChatMessage(sessionId, text, context)` function
   - Expose `subscribeToChatSession(sessionId)` / `unsubscribe`
   - Expose `sendBridgeCommand(action, payload)` function
   - Add heartbeat timeout (close + reconnect if no message for 30s)

2. `src/popup/popupV2/httpChatAdapter.ts` — rewrite `createHttpChatAdapter()`:
   - Replace `fetch(POST /send)` + `parseSSEStream()` with WebSocket `chat:send` message
   - Listen for `chat:event` / `chat:done` on the WebSocket instead of SSE
   - Keep `responseBuilder()` unchanged (same stream message processing)
   - Keep `useHttpHistoryAdapter()` unchanged (message history fetch stays HTTP)

3. `src/popup/popupV2/shared.ts` — modify `postBridge()` (line 148):
   - Send `{ type: "bridge", action, payload }` over WebSocket instead of `fetch(POST /bridge)`
   - Fall back to HTTP POST if WebSocket is not connected

---

## Phase 2: Process Supervision

**What:** Add automatic recovery when the Rust processes (window-monitor, webview-manager) crash or become unresponsive.

### 2A. Auto-respawn on crash

**File to modify:** `src/windowMonitorService.ts`

Add respawn logic to exit handlers:

**webview-manager (line 370):**
```typescript
this.webviewManagerProcess.on('exit', (code, signal) => {
  logger.info('webview-manager exited', { code, signal });
  this.webviewManagerProcess = null;
  if (!this.stopped) {
    this.scheduleWebviewManagerRespawn();
  }
});
```

**window-monitor (line 398):**
```typescript
proc.on('exit', (code, signal) => {
  logger.info(`window-monitor (${processKey}) exited`, { code, signal });
  this.windowMonitorProcesses.delete(processKey);
  if (!this.stopped) {
    this.scheduleWindowMonitorRespawn(processKey, wmBin, wmArgs);
  }
});
```

**Respawn logic:**
- Exponential backoff: 500ms, 1s, 2s, 4s, max 10s
- Reset backoff if process runs for >30s (not a rapid crash)
- Stop after 5 consecutive rapid crashes — log error, update tray status
- Add `stopped: boolean` flag, set to `true` in `stop()`, `false` in `start()`

**After webview-manager respawn:** call `pushWebviewState()` to re-send the last desired state (`this.lastDesiredState`) so overlay windows are restored to correct position.

### 2B. Watchdog timer for window-monitor

A hung process doesn't exit — it just stops producing output. Add a watchdog:

- Set a 30s timer that resets on every `handleWindowMonitorLine()` call (line 404)
- If timer fires (no events for 30s), kill the window-monitor process — the exit handler from 2A will respawn it
- Only activate when a tracked host app is running (check `this.state` for active windows)
- Disable watchdog when no host apps are focused (no events expected)

**File to modify:** `src/windowMonitorService.ts`
- Add `watchdogTimers: Map<string, NodeJS.Timeout>` per window-monitor process key
- Reset in `handleWindowMonitorLine()` (need to know which process produced the line — add process key routing)

### 2C. Act on webview-manager error responses

Currently (line 356-358), webview-manager stdout is logged at DEBUG and ignored.

**Change to:**
```typescript
wvRl.on('line', (line) => {
  try {
    const resp = JSON.parse(line);
    if (resp.status === 'ERROR') {
      logger.error('webview-manager error:', resp);
      this.pushWebviewState(); // retry by re-sending desired state
    }
  } catch {
    logger.debug('webview-manager non-JSON:', line);
  }
});
```

The Rust `Manager::reconcile()` is idempotent (diffs desired vs actual), so re-sending the same desired state is safe.

### 2D. Fix the restart() method

Current `restart()` (line 1417) has a hardcoded 3s `setTimeout`.

**Replace with:**
```typescript
async restart(): Promise<void> {
  const { baseUrl, authToken, allAppsEnabled } = this;
  if (!baseUrl || !authToken) return;
  
  this.stop();
  // Wait for all processes to actually exit (or 2s timeout)
  await this.waitForProcessExit(2000);
  this.start(baseUrl, authToken, allAppsEnabled);
}
```

Add `waitForProcessExit()` that resolves when all child process `exit` events fire, or after timeout.

---

## Phase 3: Polish

### 3A. Connection status indicator
Surface WebSocket connection state in the overlay UI — a small banner or dot when disconnected, so users know the overlay is degraded.

### 3B. Structured process lifecycle logging
Add structured log events: `process.spawn`, `process.exit`, `process.respawn`, `process.respawn_limit` with process name, exit code, signal, backoff delay, attempt count.

---

## Sequencing

- **Phase 1 and Phase 2 are independent** — can be developed in parallel
- Within Phase 1: 1A → 1B/1C (parallel) → 1D (after 1C) → 1E (after 1C)
- Within Phase 2: 2A first (foundation) → 2B (depends on 2A) → 2C/2D (independent)
- Phase 3 depends on Phase 1 completion

## Verification

1. **Phase 1:** Open overlay over Word, send a chat message — verify events stream over WebSocket (not SSE). Toggle dock/undock — verify bridge commands go over WebSocket. Check browser DevTools network tab: should see only one WebSocket connection, no SSE streams, no POST /bridge calls.
2. **Phase 2:** Kill the webview-manager process (`kill -9 <pid>`) — verify overlay recovers within a few seconds. Kill window-monitor — verify overlay position tracking resumes. Check logs for `process.respawn` entries.
3. **Cross-surface sync:** Send a message from the desktop app — verify it appears in the overlay. Send from overlay — verify it appears on desktop.
