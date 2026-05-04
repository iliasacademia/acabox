/**
 * MCP HTTP Proxy — exposes all host-side MCP servers as HTTP MCP endpoints.
 *
 * The in-container agent SDK connects to these via `type: 'http'` MCP config.
 * Each server is mounted at /mcp/<name> to preserve the original server names
 * (which determine tool name prefixes like mcp__activity__query_activity).
 *
 * Reuses the existing createXxxMcpServer() functions — extracts the underlying
 * McpServer instance and connects it to an HTTP transport.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import log from 'electron-log';

import { createActivityMcpServer } from './mcpServers/activityMcpServer';
import { createNotificationMcpServer } from './mcpServers/notificationMcpServer';
import { createReactionMcpServer } from './mcpServers/reactionMcpServer';
import { createMsWordMcpServer } from './mcpServers/msWordMcpServer';
import { createCiteRightMcpServer } from './mcpServers/citeRightMcpServer';
import { createMiniAppMcpServer } from './agentSession';

import type { Workspace, NotificationNavigationAction } from '../shared/types';

interface McpRoute {
  name: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export class McpHttpProxy {
  private httpServer: HttpServer | null = null;
  private routes = new Map<string, McpRoute>();
  private port = 0;

  constructor(
    private workspace: Workspace,
    private onNotificationClick?: (action: NotificationNavigationAction | null) => void,
  ) {}

  async start(): Promise<number> {
    // Create all MCP servers using existing factory functions
    const serverConfigs: Record<string, ReturnType<typeof createActivityMcpServer>> = {
      activity: createActivityMcpServer(),
      notification: createNotificationMcpServer(this.onNotificationClick),
      reaction: createReactionMcpServer(this.workspace.id),
      'ms-word': createMsWordMcpServer(),
      citeright: createCiteRightMcpServer(),
      'mini-apps': createMiniAppMcpServer(this.workspace.directory_path),
    };

    // Extract McpServer instances and create HTTP transports
    for (const [name, config] of Object.entries(serverConfigs)) {
      const mcpServer = config.instance as McpServer;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });

      await mcpServer.connect(transport);

      this.routes.set(name, { name, transport, server: mcpServer });
      log.debug(`[McpHttpProxy] Registered server: ${name}`);
    }

    // Create HTTP server that routes to the correct MCP transport
    this.httpServer = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[McpHttpProxy] Error handling ${req.method} ${req.url}:`, msg);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.listen(0, '0.0.0.0', () => {
        const addr = this.httpServer!.address();
        if (typeof addr === 'object' && addr) {
          this.port = addr.port;
          log.info(`[McpHttpProxy] Listening on 0.0.0.0:${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error('Failed to bind MCP HTTP proxy'));
        }
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Returns the MCP server URLs for the agent config, keyed by server name.
   * The agent server configures each as a `type: 'http'` MCP server.
   */
  getMcpServerUrls(hostAddress: string): Record<string, { type: 'http'; url: string }> {
    const urls: Record<string, { type: 'http'; url: string }> = {};
    for (const name of this.routes.keys()) {
      urls[name] = {
        type: 'http',
        url: `http://${hostAddress}:${this.port}/mcp/${name}`,
      };
    }
    return urls;
  }

  async stop(): Promise<void> {
    for (const route of this.routes.values()) {
      await route.transport.close().catch(() => {});
    }
    this.routes.clear();

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    log.info('[McpHttpProxy] Stopped');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    log.debug(`[McpHttpProxy] ${req.method} ${url}`);

    // Health check
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', servers: [...this.routes.keys()] }));
      return;
    }

    // Route: /mcp/<server-name> or /mcp/<server-name>/...
    const match = url.match(/^\/mcp\/([^/]+)/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown route: ${url}` }));
      return;
    }

    const serverName = match[1];
    const route = this.routes.get(serverName);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown MCP server: ${serverName}` }));
      return;
    }

    // Delegate to the MCP transport
    await route.transport.handleRequest(req, res);
  }
}
