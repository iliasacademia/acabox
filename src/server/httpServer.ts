/**
 * HTTP Server for Academia Electron
 *
 * Provides a local REST API for WKWebView-based overlays to fetch data.
 * Replaces MessageBridge for data operations (not all bridge operations).
 *
 * Security:
 * - Only listens on 127.0.0.1 (localhost)
 * - Token-based authentication (Bearer tokens)
 * - Tokens generated per webview and injected into HTML
 *
 * Architecture:
 * - Uses Fastify for performance and TypeScript support
 * - Modular routes in /routes directory
 * - Authentication middleware in /middleware
 */

import Fastify, { FastifyInstance } from 'fastify';
import { TokenManager, createAuthMiddleware } from './middleware/auth';
import { registerNotificationRoutes } from './routes/notifications';
import { ServerConfig, HealthResponse } from './types';

/**
 * Academia HTTP Server
 *
 * Manages the local HTTP API server for data fetching
 */
export class AcademiaHttpServer {
  private fastify: FastifyInstance | null = null;
  private tokenManager: TokenManager;
  private config: ServerConfig;
  private notificationManager: any;
  private currentUserId: () => number | null;
  private actualPort: number | null = null;
  private serverStartTime: number = 0;

  /**
   * Create a new HTTP server instance
   *
   * @param notificationManager NotificationManager instance for data access
   * @param currentUserId Function that returns current user ID
   * @param config Server configuration (optional)
   */
  constructor(
    notificationManager: any,
    currentUserId: () => number | null,
    config: Partial<ServerConfig> = {}
  ) {
    this.notificationManager = notificationManager;
    this.currentUserId = currentUserId;
    this.tokenManager = new TokenManager();

    // Default config: listen on port 23111 on localhost
    this.config = {
      port: config.port ?? 23111,
      host: config.host ?? '127.0.0.1',
    };

    console.log('[HTTP Server] Initialized with config:', this.config);
  }

  /**
   * Start the HTTP server
   *
   * @returns Promise that resolves with the actual port the server is listening on
   */
  async start(): Promise<number> {
    if (this.fastify) {
      console.log('[HTTP Server] Server already running');
      return this.actualPort!;
    }

    // Create Fastify instance
    this.fastify = Fastify({
      logger: false, // Disable Fastify's built-in logger (we use console.log)
      disableRequestLogging: true,
    });

    // Register global error handler
    this.fastify.setErrorHandler((error, request, reply) => {
      console.error('[HTTP Server] Error handling request:', error);

      // Map validation errors (400 status) to BadRequest
      const errorName = error.statusCode === 400 ? 'BadRequest' : (error.name || 'InternalServerError');

      reply.code(error.statusCode || 500).send({
        error: errorName,
        message: error.message || 'An unexpected error occurred',
        statusCode: error.statusCode || 500,
      });
    });

    // Register authentication middleware for all routes except /api/health and /api/notifications/count
    this.fastify.addHook('preHandler', async (request, reply) => {
      // Skip auth for health check and notification count
      if (request.url === '/api/health' || request.url === '/api/notifications/count') {
        return;
      }

      // Apply auth middleware
      const authMiddleware = createAuthMiddleware(this.tokenManager);
      await authMiddleware(request, reply);
    });

    // Register health check endpoint (no auth required)
    this.fastify.get('/api/health', async (request, reply) => {
      const response: HealthResponse = {
        status: 'ok',
        uptime: Date.now() - this.serverStartTime,
        timestamp: Date.now(),
      };
      reply.send(response);
    });

    // Register notification routes (auth required)
    await registerNotificationRoutes(
      this.fastify,
      this.notificationManager,
      this.currentUserId
    );

    // Start listening
    try {
      const address = await this.fastify.listen({
        port: this.config.port,
        host: this.config.host,
      });

      this.actualPort = (this.fastify.server.address() as any).port;
      this.serverStartTime = Date.now();

      console.log(`[HTTP Server] ✓ Server listening on ${address}`);
      console.log(`[HTTP Server] Actual port: ${this.actualPort}`);

      return this.actualPort!; // Non-null assertion: actualPort is set on line 125
    } catch (error) {
      console.error('[HTTP Server] Failed to start server:', error);
      throw error;
    }
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    if (!this.fastify) {
      console.log('[HTTP Server] Server not running');
      return;
    }

    console.log('[HTTP Server] Stopping server...');

    try {
      await this.fastify.close();
      this.fastify = null;
      this.actualPort = null;

      // Revoke all tokens on shutdown
      this.tokenManager.revokeAllTokens();

      console.log('[HTTP Server] ✓ Server stopped');
    } catch (error) {
      console.error('[HTTP Server] Error stopping server:', error);
      throw error;
    }
  }

  /**
   * Get the actual port the server is listening on
   * Will be different from config.port if config.port was 0 (random port)
   *
   * @returns Port number or null if server not running
   */
  getPort(): number | null {
    return this.actualPort;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.fastify !== null && this.actualPort !== null;
  }

  /**
   * Generate a new authentication token
   * Token should be injected into webview HTML for authenticated requests
   *
   * @param identifier Optional identifier for debugging (e.g., "NotificationsPopover")
   * @returns Token string
   */
  generateToken(identifier?: string): string {
    const metadata = this.tokenManager.generateToken(identifier);
    return metadata.token;
  }

  /**
   * Revoke an authentication token
   *
   * @param token Token to revoke
   * @returns true if token was revoked, false if it didn't exist
   */
  revokeToken(token: string): boolean {
    return this.tokenManager.revokeToken(token);
  }

  /**
   * Get count of active tokens
   * Useful for debugging
   */
  getActiveTokenCount(): number {
    return this.tokenManager.getActiveTokenCount();
  }

  /**
   * Get the base URL for the API
   * Use this to construct full URLs for webviews
   *
   * Example: http://127.0.0.1:52341
   *
   * @returns Base URL or null if server not running
   */
  getBaseUrl(): string | null {
    if (!this.actualPort) {
      return null;
    }
    return `http://${this.config.host}:${this.actualPort}`;
  }

  /**
   * Get token manager (for advanced usage)
   * Generally you should use generateToken() instead
   */
  getTokenManager(): TokenManager {
    return this.tokenManager;
  }
}

/**
 * Singleton instance (optional pattern)
 * You can use this or create your own instance
 */
let serverInstance: AcademiaHttpServer | null = null;

/**
 * Get or create singleton server instance
 *
 * @param notificationManager NotificationManager instance
 * @param currentUserId Function returning current user ID
 * @returns Server instance
 */
export function getServerInstance(
  notificationManager?: any,
  currentUserId?: () => number | null
): AcademiaHttpServer {
  if (!serverInstance && notificationManager && currentUserId) {
    serverInstance = new AcademiaHttpServer(notificationManager, currentUserId);
  }

  if (!serverInstance) {
    throw new Error('Server instance not initialized. Call with required parameters first.');
  }

  return serverInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetServerInstance(): void {
  serverInstance = null;
}
