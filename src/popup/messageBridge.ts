/**
 * Message Bridge - TypeScript/JavaScript side
 *
 * Provides bidirectional communication between JavaScript and native code
 * Works across multiple platforms (macOS WKWebView, Windows WebView2)
 */

// ========== Type Definitions ==========

export type MessageType = 'request' | 'response' | 'event' | 'state-update' | 'error';
export type Priority = 'high' | 'normal' | 'low';

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  action: string;
  payload: any;
  priority?: Priority;
  timestamp: number;
  timeoutMs?: number;
}

export type MessageHandler = (msg: Message) => void | Promise<void>;
export type ResponseCallback = (response: Message) => void;

// ========== Platform Detection ==========

interface WebKitMessageHandlers {
  bridge?: {
    postMessage: (message: any) => void;
  };
}

interface WebKitInterface {
  messageHandlers?: WebKitMessageHandlers;
}

interface ChromeWebView {
  postMessage: (message: any) => void;
  addEventListener: (event: string, callback: (e: any) => void) => void;
}

interface ChromeInterface {
  webview?: ChromeWebView;
}

declare global {
  interface Window {
    webkit?: WebKitInterface;
    chrome?: ChromeInterface;
    __bridgeSend?: (msg: Message) => void;
    __bridgeReceive?: (msg: Message) => void;
    __bridgeOn?: (action: string, handler: MessageHandler) => void;
    __bridgeOff?: (action: string) => void;
    __bridgeHandlers?: Record<string, MessageHandler>;
    __messageBridge?: MessageBridge;
    __pendingResponses?: Message[];
  }
}

// ========== MessageBridge Class ==========

export class MessageBridge {
  private clientId: string;
  private instanceId: string;
  private handlers = new Map<string, MessageHandler>();
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeoutId: NodeJS.Timeout;
  }>();
  private platform: 'webkit' | 'webview2' | 'unknown';
  private isReady = false;
  private messageQueue: Message[] = [];

  constructor(clientId: string) {
    this.clientId = clientId;
    this.instanceId = `${clientId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.platform = this.detectPlatform();

    console.log(`[MessageBridge] Creating new instance: ${this.instanceId}`);

    // Store reference to old instance before overwriting (for hot-reload support)
    const oldBridge = window.__messageBridge;

    // Detect if we're overwriting an existing instance
    if (oldBridge) {
      console.warn('[MessageBridge] Instance replacement detected - transferring pending requests');
      console.warn('[MessageBridge] Old instance pending requests:', oldBridge.pendingRequests?.size || 0);
    }

    // CRITICAL: Register this instance globally IMMEDIATELY
    // This ensures that when responses come back, they're routed to the correct instance
    window.__messageBridge = this;

    // Transfer pending requests from old instance (hot-reload support)
    // Must happen AFTER window.__messageBridge is set but BEFORE processPreloadQueue
    if (oldBridge && oldBridge.pendingRequests) {
      const oldRequests = oldBridge.pendingRequests;
      let transferCount = 0;

      oldRequests.forEach((value, key) => {
        this.pendingRequests.set(key, value);
        transferCount++;
      });

      if (transferCount > 0) {
        console.warn(`[MessageBridge] Transferred ${transferCount} pending request(s) from old instance`);
      }
    }

    // WAGENT-68: Process any responses that arrived before MessageBridge was initialized
    // This MUST happen synchronously before any async operations to guarantee no responses are lost
    this.processPreloadQueue();

    this.setupNativeInterface();

    console.log(`[MessageBridge] Initialized for client: ${clientId}, platform: ${this.platform}, instance: ${this.instanceId}`);
  }

  // ========== Queue Processing ==========

  /**
   * WAGENT-68: Process responses that arrived before MessageBridge was initialized
   * This runs synchronously during construction to guarantee no responses are lost
   */
  private processPreloadQueue() {
    if (window.__pendingResponses && window.__pendingResponses.length > 0) {
      console.log(`[MessageBridge] Processing ${window.__pendingResponses.length} queued responses (WAGENT-68)`);
      const pendingResponses = window.__pendingResponses;
      window.__pendingResponses = []; // Clear the queue

      for (const response of pendingResponses) {
        console.log(`[MessageBridge] Processing queued response: ${response.action}`);
        this.handleNativeMessage(response);
      }
    }
  }

  // ========== Platform Detection ==========

  private detectPlatform(): 'webkit' | 'webview2' | 'unknown' {
    if (window.webkit?.messageHandlers?.bridge) {
      return 'webkit';
    } else if (window.chrome?.webview) {
      return 'webview2';
    }
    return 'unknown';
  }

  private setupNativeInterface() {
    // Initialize the handlers registry that native code expects
    if (!window.__bridgeHandlers) {
      window.__bridgeHandlers = {};
    }

    if (this.platform === 'webkit') {
      // macOS WKWebView - functions are already injected by native code
      // We need to wrap __bridgeReceive to route through our handler system
      const checkAndSetup = () => {
        if (!window.__bridgeSend || !window.__bridgeReceive) {
          // console.warn('[MessageBridge] WebKit bridge functions not available, waiting...');
          // Retry after a delay
          setTimeout(checkAndSetup, 200);
          return;
        }

        console.log('[MessageBridge] WebKit bridge functions now available');

        // Process any responses that arrived before MessageBridge was initialized
        if (window.__pendingResponses && window.__pendingResponses.length > 0) {
          console.log(`[MessageBridge] Processing ${window.__pendingResponses.length} queued responses`);
          const pendingResponses = window.__pendingResponses;
          window.__pendingResponses = []; // Clear the queue

          for (const response of pendingResponses) {
            console.log(`[MessageBridge] Processing queued response: ${response.action}`);
            this.handleNativeMessage(response);
          }
        }

        this.sendReadySignal();
      };

      checkAndSetup();

      // WAGENT-81: Add timeout protection to clear stale queue
      // If MessageBridge fails to initialize within 5 seconds, clear the queue to prevent memory leaks
      setTimeout(() => {
        if (window.__pendingResponses && window.__pendingResponses.length > 0) {
          console.error(
            `[MessageBridge] ${window.__pendingResponses.length} responses still queued after 5s - clearing (WAGENT-81)`
          );
          window.__pendingResponses = [];
        }
      }, 5000);
    } else if (this.platform === 'webview2') {
      // Windows WebView2
      window.chrome!.webview!.addEventListener('message', (e: any) => {
        this.handleNativeMessage(e.data);
      });
      this.sendReadySignal();
    } else {
      console.error('[MessageBridge] Unknown platform, bridge may not work');
    }
  }

  private sendReadySignal() {
    // Send ready signal to native
    const readyMsg: Message = {
      id: this.generateId(),
      from: this.clientId,
      to: 'native',
      type: 'event',
      action: 'bridge-ready',
      payload: null,
      timestamp: Date.now()
    };

    this.sendToNative(readyMsg);
    this.isReady = true;

    // Process any queued messages
    this.processQueue();

    console.log('[MessageBridge] Ready signal sent to native');
  }

  // ========== Message Sending ==========

  private sendToNative(msg: Message) {
    // Ensure required fields
    if (!msg.id) {
      msg.id = this.generateId();
    }
    if (!msg.from) {
      msg.from = this.clientId;
    }
    if (!msg.timestamp) {
      msg.timestamp = Date.now();
    }

    if (this.platform === 'webkit') {
      if (window.__bridgeSend) {
        window.__bridgeSend(msg);
      } else if (window.webkit?.messageHandlers?.bridge) {
        window.webkit.messageHandlers.bridge.postMessage(msg);
      } else {
        console.error('[MessageBridge] Cannot send message: no bridge available');
      }
    } else if (this.platform === 'webview2') {
      window.chrome!.webview!.postMessage(msg);
    } else {
      console.error('[MessageBridge] Cannot send message: unknown platform');
    }
  }

  /**
   * Send a fire-and-forget event message
   */
  public sendEvent(to: string, action: string, payload: any = null) {
    const msg: Message = {
      id: this.generateId(),
      from: this.clientId,
      to,
      type: 'event',
      action,
      payload,
      timestamp: Date.now()
    };

    if (!this.isReady) {
      this.messageQueue.push(msg);
      return;
    }

    this.sendToNative(msg);
  }

  /**
   * Send a request and await response (promise-based)
   */
  public async sendRequest(
    to: string,
    action: string,
    payload: any = null,
    timeoutMs: number = 5000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const msgId = this.generateId();

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(msgId);
        reject(new Error(`Request timeout: ${action} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(msgId, { resolve, reject, timeoutId });

      // Debug logging - Maps don't JSON.stringify properly, so use Array.from
      console.log(`[MessageBridge ${this.instanceId}] pendingRequests size:`, this.pendingRequests.size);
      console.log(`[MessageBridge ${this.instanceId}] pendingRequests keys:`, Array.from(this.pendingRequests.keys()));
      console.log(`[MessageBridge ${this.instanceId}] This instance ID:`, this.instanceId);
      console.log(`[MessageBridge ${this.instanceId}] Global instance ID:`, (window.__messageBridge as any)?.instanceId);
      console.log(`[MessageBridge ${this.instanceId}] Same instance?`, this === window.__messageBridge);

      // WAGENT-73: Send ACK immediately after registering pending request
      // This eliminates the race condition that required a 10ms delay on native side
      this.sendEvent(to, 'request-registered', { requestId: msgId });
      console.log(`[MessageBridge] Sent ACK for request: ${msgId}`);

      const msg: Message = {
        id: msgId,
        from: this.clientId,
        to,
        type: 'request',
        action,
        payload,
        timestamp: Date.now(),
        timeoutMs
      };

      if (!this.isReady) {
        this.messageQueue.push(msg);
      } else {
        this.sendToNative(msg);
      }

      console.log(`[MessageBridge] Request sent: ${action} (id: ${msgId})`);
    });
  }

  /**
   * Send a response to a request
   */
  public sendResponse(originalMsg: Message, payload: any) {
    const msg: Message = {
      id: originalMsg.id, // Use same ID for response
      from: this.clientId,
      to: originalMsg.from,
      type: 'response',
      action: originalMsg.action,
      payload,
      timestamp: Date.now()
    };

    this.sendToNative(msg);
    console.log(`[MessageBridge] Response sent for: ${originalMsg.action}`);
  }

  // ========== Message Receiving ==========

  public handleNativeMessage(msg: Message) {
    console.log(`[MessageBridge ${this.instanceId}] Received from native: ${msg.action} (type: ${msg.type})`);

    // Handle responses to pending requests
    if (msg.type === 'response' || msg.type === 'error') {
      console.log(`[MessageBridge ${this.instanceId}] Response received with ID: ${msg.id}`);
      console.log(`[MessageBridge ${this.instanceId}] Current pending requests:`, Array.from(this.pendingRequests.keys()));
      console.log(`[MessageBridge ${this.instanceId}] pendingRequests size:`, this.pendingRequests.size);

      // FIRST: Check if THIS instance has the pending request
      let pending = this.pendingRequests.get(msg.id);
      let foundInInstance: MessageBridge | null = null;

      if (pending) {
        foundInInstance = this;
        console.log(`[MessageBridge] Found matching pending request in current instance for ID: ${msg.id}`);
      }
      // SECOND: If not found, check if there's a different global instance with this request
      // This handles the case where a new instance was created after the request was sent
      else if (window.__messageBridge && window.__messageBridge !== this) {
        console.log(`[MessageBridge] Checking global instance (different from current)`);
        pending = window.__messageBridge.pendingRequests.get(msg.id);
        if (pending) {
          foundInInstance = window.__messageBridge;
          console.log(`[MessageBridge] Found matching pending request in global instance for ID: ${msg.id}`);
        }
      }

      if (pending && foundInInstance) {
        clearTimeout(pending.timeoutId);
        foundInInstance.pendingRequests.delete(msg.id);

        if (msg.type === 'error') {
          pending.reject(new Error(msg.payload?.error || 'Unknown error'));
        } else {
          pending.resolve(msg.payload);
        }
        return;
      } else {
        console.warn(`[MessageBridge] No pending request found for response ID: ${msg.id}`);
        console.warn(`[MessageBridge] Response message:`, JSON.stringify(msg));
        console.warn(`[MessageBridge] Checked this instance (${this.instanceId}) and global instance (${window.__messageBridge?.instanceId})`);
        // Don't fall through to handler lookup for responses/errors
        return;
      }
    }

    // Handle state updates
    if (msg.type === 'state-update') {
      const handler = this.handlers.get('stateUpdate');
      if (handler) {
        handler(msg);
      }
      return;
    }

    // Handle regular messages
    const handler = this.handlers.get(msg.action);
    if (handler) {
      // Call handler
      const result = handler(msg);

      // If handler returns a promise and this was a request, send response when complete
      if (result instanceof Promise && msg.type === 'request') {
        result
          .then((responsePayload) => {
            this.sendResponse(msg, responsePayload);
          })
          .catch((error) => {
            this.sendResponse(msg, { error: error.message });
          });
      }
    } else {
      console.warn(`[MessageBridge] No handler for action: ${msg.action}`);
    }
  }

  // ========== Handler Registration ==========

  /**
   * Register a handler for a specific action
   */
  public on(action: string, handler: MessageHandler) {
    this.handlers.set(action, handler);

    // CRITICAL: Also register in window.__bridgeHandlers for native compatibility
    // The native injected script expects handlers here
    if (!window.__bridgeHandlers) {
      window.__bridgeHandlers = {};
    }
    window.__bridgeHandlers[action] = handler;

    console.log(`[MessageBridge] Handler registered: ${action}`);
  }

  /**
   * Unregister a handler
   */
  public off(action: string) {
    this.handlers.delete(action);

    // Also remove from window.__bridgeHandlers
    if (window.__bridgeHandlers && window.__bridgeHandlers[action]) {
      delete window.__bridgeHandlers[action];
    }

    console.log(`[MessageBridge] Handler unregistered: ${action}`);
  }

  // ========== Queue Management ==========

  private processQueue() {
    if (!this.isReady || this.messageQueue.length === 0) {
      return;
    }

    console.log(`[MessageBridge] Processing ${this.messageQueue.length} queued messages`);

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      if (msg) {
        this.sendToNative(msg);
      }
    }
  }

  // ========== Utilities ==========

  private generateId(): string {
    return `${this.clientId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  public getClientId(): string {
    return this.clientId;
  }

  public getPlatform(): string {
    return this.platform;
  }

  public isConnected(): boolean {
    return this.isReady;
  }

  /**
   * Destroy the bridge instance
   * Cleans up pending requests, handlers, and global references
   */
  public destroy(): void {
    console.log('[MessageBridge] Destroying bridge instance');

    // Cancel all pending request timeouts and reject them
    this.pendingRequests.forEach((request, requestId) => {
      clearTimeout(request.timeoutId);
      request.reject(new Error('Bridge destroyed'));
    });

    // Clear pending requests
    this.pendingRequests.clear();

    // Clear handlers
    this.handlers.clear();

    // Clear window globals
    if (window.__bridgeHandlers) {
      window.__bridgeHandlers = {};
    }

    if (window.__messageBridge === this) {
      delete window.__messageBridge;
    }

    console.log('[MessageBridge] Bridge instance destroyed');
  }
}

// ========== Default Export ==========

export default MessageBridge;
