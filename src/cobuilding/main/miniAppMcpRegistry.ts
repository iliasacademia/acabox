/**
 * Mini-app MCP registry.
 *
 * Mini-apps can declare an `mcp` section in their `manifest.json` exposing
 * tools that other mini-apps and the Claude agent can call. When a mini-app's
 * iframe loads, the renderer registers its server here with a `route` that
 * lets us postMessage tool invocations back to the iframe. When the iframe
 * unloads, the entry is removed.
 *
 * Cross-mini-app and agent → mini-app tool calls all flow through this single
 * registry, so allowlisting, lifecycle, and logging are one-stop-shop.
 */

import { WebContents } from 'electron';
import log from 'electron-log';
import { randomUUID } from 'crypto';

export interface MiniAppToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MiniAppMcpServer {
  /** Stable identifier used in MCP tool names (`mcp__<serverName>__<tool>`). */
  serverName: string;
  /** Mini-app directory name (under `.applications/`). */
  dirName: string;
  /** Tool definitions declared in the mini-app's manifest. */
  tools: MiniAppToolDef[];
}

interface RegisteredEntry extends MiniAppMcpServer {
  /** The WebContents of the iframe's host renderer — used to route postMessages back. */
  hostWebContents: WebContents;
  /** Routing key the renderer uses to dispatch the invocation to the right iframe. */
  iframeRouteKey: string;
}

interface PendingInvocation {
  resolve: (value: { result?: unknown; error?: string }) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

const INVOCATION_TIMEOUT_MS = 60_000;

class MiniAppMcpRegistry {
  private servers = new Map<string, RegisteredEntry>();
  private pending = new Map<string, PendingInvocation>();
  // WebContents → listener, so a destroyed renderer reaps all its
  // registrations even if the renderer never sent an explicit unregister
  // (renderer crash, window closed mid-turn, etc).
  private destroyHandlers = new WeakMap<WebContents, () => void>();
  // Live-status fan-out (design: `docs/design/mcp-hosting.md`, Increment 3),
  // mirroring the `Set<callback>` + emit pattern in `jobRegistry.ts` /
  // `buildHealth.ts` / `connectorsStore.ts`'s connector status.
  private listeners = new Set<(servers: MiniAppMcpServer[]) => void>();

  register(entry: {
    serverName: string;
    dirName: string;
    tools: MiniAppToolDef[];
    hostWebContents: WebContents;
    iframeRouteKey: string;
  }): void {
    if (!entry.serverName || /[^a-zA-Z0-9_-]/.test(entry.serverName)) {
      log.warn(`[MiniAppMcp] Refusing to register invalid serverName: ${entry.serverName}`);
      return;
    }
    if (this.servers.has(entry.serverName)) {
      log.info(`[MiniAppMcp] Replacing existing registration for ${entry.serverName}`);
    }
    this.servers.set(entry.serverName, entry);
    log.info(`[MiniAppMcp] Registered ${entry.serverName} (${entry.dirName}) with ${entry.tools.length} tool(s)`);

    // Reap on WebContents destroy. The WeakMap key ensures we don't register
    // duplicate listeners on the same WebContents across multiple iframes.
    if (!this.destroyHandlers.has(entry.hostWebContents)) {
      const handler = () => this.unregisterByWebContents(entry.hostWebContents);
      entry.hostWebContents.once('destroyed', handler);
      this.destroyHandlers.set(entry.hostWebContents, handler);
    }
    this.emitChanged();
  }

  private unregisterByWebContents(wc: WebContents): void {
    let removedAny = false;
    for (const [name, entry] of this.servers) {
      if (entry.hostWebContents === wc) {
        this.servers.delete(name);
        log.info(`[MiniAppMcp] Reaped ${name} after WebContents destroyed`);
        removedAny = true;
      }
    }
    this.destroyHandlers.delete(wc);
    // Notify AFTER the loop, not per-entry — this runs from a 'destroyed'
    // listener, so `wc` is already gone by the time any subscriber (e.g. a
    // broadcast that sends to `BrowserWindow.getAllWindows()`) reacts. That
    // broadcast must itself tolerate an already-destroyed sender; it does,
    // by checking `!win.isDestroyed()` the same way every other broadcast in
    // this codebase does.
    if (removedAny) this.emitChanged();
  }

  unregister(serverName: string): void {
    if (this.servers.delete(serverName)) {
      log.info(`[MiniAppMcp] Unregistered ${serverName}`);
      this.emitChanged();
    }
  }

  unregisterByRoute(iframeRouteKey: string): void {
    let removedAny = false;
    for (const [name, entry] of this.servers) {
      if (entry.iframeRouteKey === iframeRouteKey) {
        this.servers.delete(name);
        log.info(`[MiniAppMcp] Unregistered ${name} (route ${iframeRouteKey})`);
        removedAny = true;
      }
    }
    if (removedAny) this.emitChanged();
  }

  private emitChanged(): void {
    const snapshot = this.list();
    for (const l of this.listeners) {
      try { l(snapshot); } catch (err) { log.warn(`[MiniAppMcp] listener threw: ${(err as Error).message}`); }
    }
  }

  /** Subscribe to every register/unregister. Returns an unsubscribe function. */
  subscribe(cb: (servers: MiniAppMcpServer[]) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  list(): MiniAppMcpServer[] {
    return Array.from(this.servers.values()).map(({ serverName, dirName, tools }) => ({
      serverName, dirName, tools,
    }));
  }

  hasServer(serverName: string): boolean {
    return this.servers.has(serverName);
  }

  /**
   * Invoke a tool on a registered mini-app MCP. Routes the call to the
   * publishing iframe via postMessage and awaits a response (or timeout).
   */
  invoke(serverName: string, toolName: string, args: unknown): Promise<{ result?: unknown; error?: string }> {
    const entry = this.servers.get(serverName);
    if (!entry) {
      return Promise.resolve({ error: `Mini-app MCP server "${serverName}" is not currently available.` });
    }
    const tool = entry.tools.find((t) => t.name === toolName);
    if (!tool) {
      return Promise.resolve({ error: `Tool "${toolName}" is not exposed by "${serverName}".` });
    }

    const invocationId = randomUUID();
    const promise = new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(invocationId);
        resolve({ error: `Mini-app MCP "${serverName}.${toolName}" timed out after ${INVOCATION_TIMEOUT_MS}ms` });
      }, INVOCATION_TIMEOUT_MS);
      this.pending.set(invocationId, { resolve, reject, timeout });
    });

    try {
      if (entry.hostWebContents.isDestroyed()) {
        this.pending.delete(invocationId);
        return Promise.resolve({ error: `Mini-app "${entry.dirName}" is no longer open.` });
      }
      entry.hostWebContents.send('miniAppMcp:invoke', {
        invocationId,
        iframeRouteKey: entry.iframeRouteKey,
        toolName,
        args,
      });
    } catch (err) {
      this.pending.delete(invocationId);
      return Promise.resolve({ error: `Failed to dispatch to mini-app: ${(err as Error).message}` });
    }

    return promise;
  }

  /** Renderer reports an invocation result. */
  resolveInvocation(invocationId: string, payload: { result?: unknown; error?: string }): void {
    const pending = this.pending.get(invocationId);
    if (!pending) {
      log.warn(`[MiniAppMcp] Got result for unknown invocation ${invocationId}`);
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(invocationId);
    pending.resolve(payload);
  }
}

export const miniAppMcpRegistry = new MiniAppMcpRegistry();
