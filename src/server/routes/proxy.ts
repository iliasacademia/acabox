/**
 * Proxy routes for the HTTP server
 *
 * Provides transparent proxy to Academia.edu API with automatic authentication:
 * - All methods (GET, POST, PATCH, DELETE) at /proxy-api/*
 * - Automatic cookie-based authentication
 * - CSRF token injection for write operations
 * - Query parameters and request body forwarding
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { APIclient, getCsrfToken } from '../../apiClient';
import { AxiosError } from 'axios';
import { defaultLogger as logger } from '../../utils/logger';

/**
 * Determine if a request method requires CSRF token
 */
function requiresCsrfToken(method: string): boolean {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
}

/**
 * Register proxy routes on a Fastify instance
 *
 * @param fastify Fastify instance
 */
export async function registerProxyRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Wildcard proxy handler for /proxy-api/*
   *
   * Forwards all requests to Academia.edu API with automatic authentication.
   * Example: /proxy-api/v0/writing_agent/get_document?document_id=257
   * -> https://api.devdemia.com/v0/writing_agent/get_document?document_id=257
   */
  fastify.all('/proxy-api/*', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Extract the API path by removing /proxy-api/ prefix
      const apiPath = request.url.replace('/proxy-api/', '');

      logger.debug(`[Proxy API] ${request.method} /proxy-api/${apiPath}`);

      // Get authenticated API client
      const client = await APIclient();

      // Prepare headers
      const headers: Record<string, string> = {
        'content-type': request.headers['content-type'] || 'application/json',
      };

      // Add CSRF token for write operations
      if (requiresCsrfToken(request.method)) {
        headers['x-csrf-token'] = await getCsrfToken();
        logger.debug(`[Proxy API] Added CSRF token for ${request.method} request`);
      }

      // Forward the request to Academia.edu API
      const response = await client.request({
        method: request.method,
        url: apiPath,
        data: request.body,
        headers,
      });

      logger.debug(`[Proxy API] Success: ${response.status} - ${apiPath}`);

      // Forward response status and data
      reply.status(response.status).send(response.data);
    } catch (error) {
      // Handle errors from Academia.edu API
      if (error && typeof error === 'object' && 'isAxiosError' in error) {
        const axiosError = error as AxiosError;

        if (axiosError.response) {
          // Forward error response from Academia.edu
          const status = axiosError.response.status;
          const data = axiosError.response.data;

          logger.error(
            `[Proxy API] Error: ${status} - ${request.method} /proxy-api/${request.url.replace('/proxy-api/', '')}`
          );

          reply.status(status).send(data);
        } else if (axiosError.request) {
          // Request was made but no response received
          logger.error('[Proxy API] No response received:', axiosError.message);
          reply.code(503).send({
            error: 'ServiceUnavailable',
            message: 'No response from Academia.edu API',
            statusCode: 503,
          });
        } else {
          // Error setting up the request
          logger.error('[Proxy API] Request setup error:', axiosError.message);
          reply.code(500).send({
            error: 'InternalServerError',
            message: 'Failed to setup request',
            statusCode: 500,
          });
        }
      } else {
        // Non-axios error
        logger.error('[Proxy API] Unexpected error:', error);
        reply.code(500).send({
          error: 'InternalServerError',
          message: 'An unexpected error occurred',
          statusCode: 500,
        });
      }
    }
  });

  logger.debug('[Proxy API] Registered proxy routes at /proxy-api/*');
}
