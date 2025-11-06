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
import path from 'path';
import { registerNotificationRoutes } from './routes/notifications';
import { ServerConfig, HealthResponse } from './types';

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

    // Register static file serving for popup UI
    // Serve files from dist/popup at /ui/popup route
    const popupDistPath = path.join(__dirname, '..', '..', 'dist', 'popup');
    console.log('[HTTP Server] Registering static files from:', popupDistPath);

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

    // Register notification routes
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

      // Track active connections for cleanup
      this.fastify.server.on('connection', (socket) => {
        this.activeConnections.add(socket);
        socket.on('close', () => {
          this.activeConnections.delete(socket);
        });
      });

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

    // Destroy all active connections first
    console.log(`[HTTP Server] Destroying ${this.activeConnections.size} active connections...`);
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

      console.log('[HTTP Server] ✓ Server stopped');
    } catch (error) {
      console.error('[HTTP Server] Error stopping server:', error);

      // Force close by accessing underlying server
      if (this.fastify && this.fastify.server) {
        console.log('[HTTP Server] Force closing server...');
        this.fastify.server.close();
        this.fastify.server.unref(); // Allow process to exit
      }

      this.fastify = null;
      this.actualPort = null;

      // Don't throw - we still cleaned up
      console.log('[HTTP Server] ✓ Server force stopped');
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
