import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import log from 'electron-log';

interface PendingSelection {
  kind: 'selection';
  resolve: (text: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ActiveGoogleDocResult {
  /** The Google Docs URL of the active tab (edit/preview/copy variants accepted). */
  url: string | null;
  /** The synthetic `gdocs://<docId>` document path, when the extension was able to compute it. */
  documentPath: string | null;
  /** Doc title pulled from the tab, with the trailing "- Google Docs" suffix stripped. May be null. */
  title: string | null;
  /** Selected text in the active doc at the time of the call, captured by the canvas-interception bridge. May be null. */
  selectedText: string | null;
}

interface PendingActiveGoogleDoc {
  kind: 'active-google-doc';
  resolve: (result: ActiveGoogleDocResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

type PendingRequest = PendingSelection | PendingActiveGoogleDoc;

const KEEPALIVE_INTERVAL_MS = 30_000;

class BrowserExtensionWs {
  private connection: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  handleConnection(ws: WebSocket): void {
    log.info('[BrowserExtension] Client connected');

    if (this.connection && this.connection.readyState === WebSocket.OPEN) {
      this.connection.close();
    }
    this.clearKeepalive();
    this.connection = ws;
    this.keepaliveTimer = setInterval(() => {
      if (this.connection?.readyState === WebSocket.OPEN) {
        this.connection.ping();
      }
    }, KEEPALIVE_INTERVAL_MS);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!msg || typeof msg !== 'object' || !msg.id) return;
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) return;
        if (msg.type === 'selection-result' && pending.kind === 'selection') {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          pending.resolve(msg.text ?? null);
          return;
        }
        if (msg.type === 'active-google-doc-result' && pending.kind === 'active-google-doc') {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          pending.resolve({
            url: typeof msg.url === 'string' ? msg.url : null,
            documentPath: typeof msg.documentPath === 'string' ? msg.documentPath : null,
            title: typeof msg.title === 'string' ? msg.title : null,
            selectedText: typeof msg.selectedText === 'string' ? msg.selectedText : null,
          });
          return;
        }
      } catch {
        log.debug('[BrowserExtension] Failed to parse message');
      }
    });

    ws.on('close', () => {
      log.info('[BrowserExtension] Client disconnected');
      if (this.connection === ws) {
        this.connection = null;
        this.clearKeepalive();
      }
      this.resolveAllPending();
    });

    ws.on('error', (err) => {
      log.warn('[BrowserExtension] Connection error:', err.message);
    });
  }

  stop(): void {
    this.clearKeepalive();
    this.resolveAllPending();
    if (this.connection && this.connection.readyState === WebSocket.OPEN) {
      this.connection.close();
    }
    this.connection = null;
  }

  isConnected(): boolean {
    return this.connection !== null && this.connection.readyState === WebSocket.OPEN;
  }

  getSelection(timeoutMs = 2000): Promise<string | null> {
    if (!this.isConnected()) {
      return Promise.resolve(null);
    }

    const id = randomUUID();

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(id, { kind: 'selection', resolve, timer });

      this.connection!.send(JSON.stringify({ type: 'get-selection', id }));
    });
  }

  /**
   * Ask the extension whether the active tab is a Google Doc and, if so, what
   * its URL / synthetic document path are. Used by `resolveActiveGoogleDocPath`
   * to drive the Google Docs HostApp overlay. Returns null when the extension
   * is disconnected or the request times out — callers treat this the same as
   * "no active Google Doc."
   */
  getActiveGoogleDoc(timeoutMs = 2000): Promise<ActiveGoogleDocResult | null> {
    if (!this.isConnected()) {
      return Promise.resolve(null);
    }

    const id = randomUUID();

    return new Promise<ActiveGoogleDocResult | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(id, { kind: 'active-google-doc', resolve, timer });

      this.connection!.send(JSON.stringify({ type: 'get-active-google-doc', id }));
    });
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private resolveAllPending(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingRequests.clear();
  }
}

export const browserExtensionServer = new BrowserExtensionWs();
