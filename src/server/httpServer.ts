/**
 * HTTP Server for Academia Electron
 *
 * Provides a local REST API for WKWebView-based overlays to fetch data.
 * Replaces MessageBridge for data operations (not all bridge operations).
 *
 * Security:
 * - Only listens on 127.0.0.1 (localhost)
 *
 * Architecture:
 * - Uses Fastify for performance and TypeScript support
 * - Modular routes in /routes directory
 * - Serves static popup files via @fastify/static
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import path from 'path';
import { app } from 'electron';
import { registerNotificationRoutes } from './routes/notifications';
import { registerProxyRoutes } from './routes/proxy';
import { registerWordRoutes } from './routes/word';
import { registerAnalyticsRoutes } from './routes/analytics';
import { wordIntegrationDataStore } from '../wordIntegrationDataStore';
import { ServerConfig, HealthResponse } from './types';
import { TokenManager, createAuthMiddleware } from './middleware/auth';
import { defaultLogger as logger } from '../utils/logger';

/**
 * Academia HTTP Server
 *
 * Manages the local HTTP API server for data fetching
 */
export class AcademiaHttpServer {
  private fastify: FastifyInstance | null = null;
  private config: ServerConfig;
  private notificationManager: any;
  private currentUserId: () => number | null;
  private actualPort: number | null = null;
  private serverStartTime: number = 0;
  private activeConnections = new Set<any>();
  private tokenManager: TokenManager;
  private authToken: string | null = null;

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

  }

  /**
   * Start the HTTP server
   *
   * @returns Promise that resolves with the actual port the server is listening on
   */
  async start(): Promise<number> {
    if (this.fastify) {
      return this.actualPort!;
    }

    // Create Fastify instance
    this.fastify = Fastify({
      logger: false, // Disable Fastify's built-in logger (we use logger.debug)
      disableRequestLogging: true,
    });

    // Register global error handler
    this.fastify.setErrorHandler((error, request, reply) => {
      logger.error('[HTTP Server] Error handling request:', error);

      // Map validation errors (400 status) to BadRequest
      const errorName = error.statusCode === 400 ? 'BadRequest' : (error.name || 'InternalServerError');

      reply.code(error.statusCode || 500).send({
        error: errorName,
        message: error.message || 'An unexpected error occurred',
        statusCode: error.statusCode || 500,
      });
    });

    // Register CORS - allows popups (served from /ui/popup/) to fetch from API endpoints
    // Safe because server only listens on localhost (127.0.0.1)
    await this.fastify.register(cors, {
      origin: true, // Reflect request origin (safe for localhost-only server)
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
      credentials: true,
    });

    // Generate auth token and register auth middleware
    const tokenMetadata = this.tokenManager.generateToken('word-overlay');
    this.authToken = tokenMetadata.token;

    const authMiddleware = createAuthMiddleware(this.tokenManager);
    this.fastify.addHook('preHandler', async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/proxy-api/')) {
        await authMiddleware(request, reply);
      }
    });

    // Log popup requests with full URL including query params (pid and token)
    this.fastify.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/ui/popup/')) {
        logger.info(`[HttpServer] Popup request: ${request.url}`);
      }
    });

    // Register static file serving for popup UI
    // Serve files from dist/popup at /ui/popup route
    const devPopupPath = path.join(__dirname, '..', '..', 'dist', 'popup');
    const prodPopupPath = app.isPackaged
      ? path.join(process.resourcesPath, 'popup')
      : devPopupPath;
    const popupDistPath = app.isPackaged ? prodPopupPath : devPopupPath;

    await this.fastify.register(fastifyStatic, {
      root: popupDistPath,
      prefix: '/ui/popup/',
      decorateReply: false, // Don't add sendFile method to reply object
    });

    // Register health check endpoint
    this.fastify.get('/api/health', async (request, reply) => {
      const response: HealthResponse = {
        status: 'ok',
        uptime: Date.now() - this.serverStartTime,
        timestamp: Date.now(),
      };
      reply.send(response);
    });

    // Dev endpoint - only registered in development mode
    if (!app.isPackaged) {
      this.fastify.get('/dev', async (request, reply) => {
        const trackedPIDs = wordIntegrationDataStore.getTrackedPIDs();
        const token = this.authToken || '';
        const baseUrl = this.getBaseUrl() || '';

        const response = {
          token,
          baseUrl,
          trackedPIDs: trackedPIDs.map(pidInfo => ({
            pid: pidInfo.pid,
            filePath: pidInfo.filePath,
            isActive: pidInfo.isActive,
            popupUrls: {
              academiaNotifications: `${baseUrl}/ui/popup/academiaNotifications/?pid=${pidInfo.pid}&token=${token}`,
              academiaNotificationsButton: `${baseUrl}/ui/popup/academiaNotificationsButton/?pid=${pidInfo.pid}&token=${token}`,
            },
          })),
        };

        reply.send(response);
      });
    }

    // Register notification routes
    await registerNotificationRoutes(
      this.fastify,
      this.notificationManager,
      this.currentUserId
    );

    // Register proxy routes
    await registerProxyRoutes(this.fastify);

    // Register Word integration routes
    await registerWordRoutes(this.fastify);

    // Register analytics routes
    await registerAnalyticsRoutes(this.fastify);

    // Start listening - try ports in range (default 23111-23120)
    const startPort = this.config.port;
    const maxAttempts = 10;
    let lastError: Error | null = null;

    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      try {
        const address = await this.fastify.listen({
          port,
          host: this.config.host,
        });

        this.actualPort = (this.fastify.server.address() as any).port;
        this.serverStartTime = Date.now();

        // Track active connections for cleanup
        this.fastify.server.on('connection', (socket) => {
          this.activeConnections.add(socket);
          socket.on('close', () => {
            this.activeConnections.delete(socket);
          });
        });

        logger.debug(`[HTTP Server] ✓ Server listening on ${address}`);
        logger.debug(`[HTTP Server] Actual port: ${this.actualPort}`);

        return this.actualPort!;
      } catch (error: any) {
        lastError = error;
        if (error.code === 'EADDRINUSE') {
          logger.debug(`[HTTP Server] Port ${port} in use, trying next port...`);
          continue;
        }
        // For non-port-in-use errors, throw immediately
        logger.error('[HTTP Server] Failed to start server:', error);
        throw error;
      }
    }

    // All ports exhausted
    logger.error(`[HTTP Server] Failed to start server: All ports ${startPort}-${startPort + maxAttempts - 1} are in use`);
    throw lastError || new Error(`No available ports in range ${startPort}-${startPort + maxAttempts - 1}`);
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    if (!this.fastify) {
      return;
    }

    logger.debug('[HTTP Server] Stopping server...');

    // Destroy all active connections first
    for (const socket of this.activeConnections) {
      socket.destroy();
    }
    this.activeConnections.clear();

    try {
      // Create a timeout promise (5 seconds)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Server close timeout after 5 seconds')), 5000);
      });

      // Race between close and timeout
      await Promise.race([
        this.fastify.close(),
        timeoutPromise
      ]);

      this.fastify = null;
      this.actualPort = null;

      logger.debug('[HTTP Server] ✓ Server stopped');
    } catch (error) {
      logger.error('[HTTP Server] Error stopping server:', error);

      // Force close by accessing underlying server
      if (this.fastify && this.fastify.server) {
        logger.debug('[HTTP Server] Force closing server...');
        this.fastify.server.close();
        this.fastify.server.unref(); // Allow process to exit
      }

      this.fastify = null;
      this.actualPort = null;

      // Don't throw - we still cleaned up
      logger.debug('[HTTP Server] ✓ Server force stopped');
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
   * Get the authentication token for API access
   * Pass this to clients that need to make API requests
   *
   * @returns Auth token or null if server not running
   */
  getAuthToken(): string | null {
    return this.authToken;
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
