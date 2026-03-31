/**
 * Pre-review check and save routes
 *
 * V4 endpoints (no :wid param — server resolves focused window):
 * - POST /api/review-pre-check — Check duplicate names and unsaved changes
 * - POST /api/word-save — Save the focused document by name (no focus stealing)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { execFile } from 'child_process';
import path from 'path';
import { app } from 'electron';
import { windowMonitorService } from '../../windowMonitorService';
import { defaultLogger as logger } from '../../utils/logger';

function getWordActionsBinPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'word-actions');
  }
  return path.join(app.getAppPath(), 'window-monitor', 'rust', 'target', 'release', 'word-actions');
}

function runWordAction(action: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const binPath = getWordActionsBinPath();
    const jsonArg = JSON.stringify(action);

    execFile(binPath, ['--json', jsonArg], { timeout: 10000 }, (error, stdout, stderr) => {
      if (stderr) {
        logger.debug(`[ReviewPreCheck] word-actions stderr: ${stderr}`);
      }
      if (error) {
        logger.error(`[ReviewPreCheck] word-actions error:`, error);
        reject(new Error(`word-actions failed: ${error.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (parseErr) {
        reject(new Error(`Failed to parse word-actions output: ${stdout}`));
      }
    });
  });
}

function getFocusedWindowNumericId(): number | null {
  const wid = windowMonitorService.getFocusedWindowId();
  if (!wid) return null;
  const num = parseInt(wid, 10);
  return isNaN(num) ? null : num;
}

export async function registerReviewPreCheckRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/review-pre-check',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const windowId = getFocusedWindowNumericId();
      if (windowId === null) {
        reply.code(404).send({
          error: 'NotFound',
          message: 'No focused window',
          statusCode: 404,
        });
        return;
      }

      try {
        const result = await runWordAction({
          action: 'pre_check',
          window_id: windowId,
        });

        if (!result.success) {
          reply.code(500).send({
            error: 'InternalServerError',
            message: result.error || 'Pre-check failed',
            statusCode: 500,
          });
          return;
        }

        reply.send({
          canProceed: result.can_proceed,
          reason: result.reason,
          message: result.message,
        });
      } catch (err) {
        logger.error('[ReviewPreCheck] Pre-check error:', err);
        // Fail-open: if pre-check itself fails, allow review to proceed
        reply.send({ canProceed: true });
      }
    }
  );

  fastify.post(
    '/api/word-save',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const windowId = getFocusedWindowNumericId();
      if (windowId === null) {
        reply.code(404).send({
          error: 'NotFound',
          message: 'No focused window',
          statusCode: 404,
        });
        return;
      }

      try {
        const result = await runWordAction({
          action: 'save_by_name',
          window_id: windowId,
        });

        reply.send({
          success: result.success,
          error: result.error,
        });
      } catch (err) {
        logger.error('[ReviewPreCheck] Save error:', err);
        reply.code(500).send({
          success: false,
          error: 'Failed to execute save',
        });
      }
    }
  );

  logger.debug('[ReviewPreCheck] Registered routes at /api/review-pre-check and /api/word-save');
}
