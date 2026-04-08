import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import log from 'electron-log';

interface PendingRequest {
  resolve: (text: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

class BrowserExtensionWs {
  private connection: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  handleConnection(ws: WebSocket): void {
    log.info('[BrowserExtension] Client connected');

    if (this.connection && this.connection.readyState === WebSocket.OPEN) {
      this.connection.close();
    }
    this.connection = ws;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'selection-result' && msg.id) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            pending.resolve(msg.text ?? null);
          }
        }
      } catch {
        log.debug('[BrowserExtension] Failed to parse message');
      }
    });

    ws.on('close', () => {
      log.info('[BrowserExtension] Client disconnected');
      if (this.connection === ws) {
        this.connection = null;
      }
      this.resolveAllPending();
    });

    ws.on('error', (err) => {
      log.warn('[BrowserExtension] Connection error:', err.message);
    });
  }

  stop(): void {
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

      this.pendingRequests.set(id, { resolve, timer });

      this.connection!.send(JSON.stringify({ type: 'get-selection', id }));
    });
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
