/**
 * V2 Word integration routes — keyed by window ID (wid) instead of PID.
 *
 * Routes:
 * - GET /word/v2/:wid/project_file — Get project file info for a window
 * - GET /word/v2/:wid/poll — Poll status and notifications for a window
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { windowMonitorService } from '../../windowMonitorService';
import { wordIntegrationDataStoreV2 } from '../../wordIntegrationDataStoreV2';
import { WordProjectFileResponse } from '../types';
import { buildWordPollResponseV2 } from '../services/buildWordPollResponseV2';
import { getCachedUserData } from '../../userDataCache';
import { defaultLogger as logger } from '../../utils/logger';

/**
 * Register V2 Word integration routes on a Fastify instance
 */
export interface FullStoryStaticConfig {
  deviceId: string;
  appVersion: string;
  isPackaged: boolean;
  forceFullStoryRecording: boolean;
}

export async function registerWordV2Routes(
  fastify: FastifyInstance,
  notificationManager?: any,
  currentUserId?: () => number | null,
  fullStoryStaticConfig?: FullStoryStaticConfig
): Promise<void> {
  /**
   * GET /word/v2/:wid/project_file
   *
   * Get project file information for a Word window by window ID.
   */
  fastify.get<{
    Params: { wid: string };
  }>(
    '/word/v2/:wid/project_file',
    {
      schema: {
        params: {
          type: 'object',
          required: ['wid'],
          properties: {
            wid: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { wid: string } }>,
      reply: FastifyReply
    ) => {
      const { wid } = request.params;

      const documentPath = windowMonitorService.getDocumentPathForWindow(wid);
      if (!documentPath) {
        reply.code(404).send({
          error: 'NotFound',
          message: `No document path found for window ${wid}`,
          statusCode: 404,
        });
        return;
      }

      const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(documentPath);
      if (!projectFile) {
        reply.code(404).send({
          error: 'NotFound',
          message: `No project file found for window ${wid}`,
          statusCode: 404,
        });
        return;
      }

      const response: WordProjectFileResponse = {
        project_id: projectFile.project_id,
        project_file_id: projectFile.project_file_id,
      };

      reply.send(response);
    }
  );

  /**
   * GET /word/v2/:wid/poll
   *
   * Poll status for a Word window by window ID.
   */
  fastify.get<{
    Params: { wid: string };
  }>(
    '/word/v2/:wid/poll',
    {
      schema: {
        params: {
          type: 'object',
          required: ['wid'],
          properties: {
            wid: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { wid: string } }>,
      reply: FastifyReply
    ) => {
      const { wid } = request.params;
      const response = buildWordPollResponseV2(wid, notificationManager, currentUserId);
      if (fullStoryStaticConfig) {
        const cached = getCachedUserData();
        reply.send({
          ...response,
          fullStoryConfig: {
            ...fullStoryStaticConfig,
            userId: cached?.id ?? (currentUserId ? currentUserId() : null),
            email: cached?.email ?? '',
            displayName: cached?.first_name || cached?.name || '',
          },
        });
      } else {
        reply.send(response);
      }
    }
  );

  /**
   * GET /word/v4/focused/poll
   *
   * V4: Poll status for the currently focused window.
   * Returns the same WordPollResponse as v2 but resolves the focused window
   * automatically, and includes `wid` in the response so the React UI knows
   * which window the data belongs to.
   */
  fastify.get(
    '/word/v4/focused/poll',
    async (
      request: FastifyRequest,
      reply: FastifyReply
    ) => {
      const focusedWid = windowMonitorService.getFocusedWindowId();
      if (!focusedWid) {
        reply.code(404).send({
          error: 'NotFound',
          message: 'No focused window',
          statusCode: 404,
        });
        return;
      }

      const response = buildWordPollResponseV2(focusedWid, notificationManager, currentUserId);
      const data: any = { ...response, wid: focusedWid };
      if (fullStoryStaticConfig) {
        const cached = getCachedUserData();
        data.fullStoryConfig = {
          ...fullStoryStaticConfig,
          userId: cached?.id ?? (currentUserId ? currentUserId() : null),
          email: cached?.email ?? '',
          displayName: cached?.first_name || cached?.name || '',
        };
      }
      reply.send(data);
    }
  );
}
