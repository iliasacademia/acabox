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
  }
}

// ========== MessageBridge Class ==========

export class MessageBridge {
  private clientId: string;
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
    this.platform = this.detectPlatform();
    this.setupNativeInterface();

    console.log(`[MessageBridge] Initialized for client: ${clientId}, platform: ${this.platform}`);
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
          console.warn('[MessageBridge] WebKit bridge functions not available, waiting...');
          // Retry after a delay
          setTimeout(checkAndSetup, 200);
          return;
        }

        console.log('[MessageBridge] WebKit bridge functions now available');

        // Override __bridgeReceive to route through our handleNativeMessage
        // We don't need to keep the original because we're managing handlers ourselves
        window.__bridgeReceive = (msg: Message) => {
          // Call our internal message handler which will route to registered handlers
          this.handleNativeMessage(msg);
        };

        this.sendReadySignal();
      };

      checkAndSetup();
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

  private handleNativeMessage(msg: Message) {
    console.log(`[MessageBridge] Received from native: ${msg.action} (type: ${msg.type})`);

    // Handle responses to pending requests
    if (msg.type === 'response' || msg.type === 'error') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(msg.id);

        if (msg.type === 'error') {
          pending.reject(new Error(msg.payload?.error || 'Unknown error'));
        } else {
          pending.resolve(msg.payload);
        }
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
}

// ========== Default Export ==========

export default MessageBridge;
