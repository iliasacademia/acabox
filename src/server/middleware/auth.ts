/**
 * Authentication middleware for the HTTP server
 *
 * Provides token-based authentication to prevent unauthorized access
 * to the localhost HTTP API from other processes.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import { TokenMetadata } from '../types';
import { defaultLogger as logger } from '../../utils/logger';

/**
 * Token manager for tracking valid authentication tokens
 */
export class TokenManager {
  private tokens: Set<string> = new Set();
  private tokenMetadata: Map<string, TokenMetadata> = new Map();

  /**
   * Generate a new secure random token
   *
   * @param identifier Optional identifier for debugging (e.g., "webview-1")
   * @returns TokenMetadata with token string and creation time
   */
  generateToken(identifier?: string): TokenMetadata {
    // Generate 32 bytes of random data, encode as hex (64 characters)
    const token = randomBytes(32).toString('hex');

    const metadata: TokenMetadata = {
      token,
      createdAt: Date.now(),
      identifier,
    };

    this.tokens.add(token);
    this.tokenMetadata.set(token, metadata);

    logger.debug(`[TokenManager] Generated new token${identifier ? ` for ${identifier}` : ''}: ${token.substring(0, 16)}...`);

    return metadata;
  }

  /**
   * Register a pre-defined token (for development use only)
   */
  addToken(token: string, identifier?: string): void {
    const metadata: TokenMetadata = {
      token,
      createdAt: Date.now(),
      identifier,
    };
    this.tokens.add(token);
    this.tokenMetadata.set(token, metadata);
    logger.debug(`[TokenManager] Added fixed token${identifier ? ` for ${identifier}` : ''}`);
  }

  /**
   * Validate a token
   *
   * @param token Token string to validate
   * @returns true if token is valid, false otherwise
   */
  isValidToken(token: string): boolean {
    return this.tokens.has(token);
  }

  /**
   * Revoke a token (invalidate it)
   *
   * @param token Token to revoke
   * @returns true if token was revoked, false if it didn't exist
   */
  revokeToken(token: string): boolean {
    const existed = this.tokens.delete(token);
    if (existed) {
      this.tokenMetadata.delete(token);
      logger.debug(`[TokenManager] Revoked token: ${token.substring(0, 16)}...`);
    }
    return existed;
  }

  /**
   * Revoke all tokens
   * Useful for cleanup or security resets
   */
  revokeAllTokens(): void {
    const count = this.tokens.size;
    this.tokens.clear();
    this.tokenMetadata.clear();
    logger.debug(`[TokenManager] Revoked all ${count} tokens`);
  }

  /**
   * Get metadata for a token
   *
   * @param token Token to lookup
   * @returns TokenMetadata if token exists, undefined otherwise
   */
  getTokenMetadata(token: string): TokenMetadata | undefined {
    return this.tokenMetadata.get(token);
  }

  /**
   * Get count of active tokens
   */
  getActiveTokenCount(): number {
    return this.tokens.size;
  }

  /**
   * Get all token metadata (for debugging)
   * DO NOT expose this via HTTP endpoints
   */
  getAllTokenMetadata(): TokenMetadata[] {
    return Array.from(this.tokenMetadata.values());
  }
}

/**
 * Fastify plugin for token authentication
 *
 * Validates the Authorization header:
 *   Authorization: Bearer <token>
 *
 * Returns 401 if token is missing or invalid
 *
 * @param tokenManager TokenManager instance to use for validation
 */
export function createAuthMiddleware(tokenManager: TokenManager) {
  return async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Prefer the Authorization header (everything else uses Bearer), but
    // fall back to a `token` query param. The browser EventSource API can't
    // attach custom headers, so SSE endpoints (e.g. the cross-surface chat-
    // event channel `/api/cobuilding/sessions/:id/events`) need this query-
    // param path. Same token, same TokenManager validation — just a second
    // place to source it from.
    const authHeader = request.headers.authorization;
    let token: string | null = null;

    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        reply.code(401).send({
          error: 'Unauthorized',
          message: 'Malformed Authorization header. Expected: Bearer <token>',
          statusCode: 401,
        });
        return;
      }
      token = parts[1];
    } else {
      const qs = (request.query ?? {}) as Record<string, string | undefined>;
      if (typeof qs.token === 'string' && qs.token.length > 0) {
        token = qs.token;
      }
    }

    if (!token) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing Authorization header or token query param',
        statusCode: 401,
      });
      return;
    }

    if (!tokenManager.isValidToken(token)) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired token',
        statusCode: 401,
      });
      return;
    }

    // Token is valid, proceed
  };
}

/**
 * Extract token from Authorization header
 * Utility function for cases where you need the raw token
 *
 * @param authHeader Authorization header value
 * @returns Token string or null if invalid format
 */
export function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}
