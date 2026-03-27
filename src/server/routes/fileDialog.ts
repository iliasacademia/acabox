/**
 * File dialog routes for the HTTP server
 *
 * Provides filesystem browsing endpoints for the in-overlay file picker,
 * used when HTML <input type="file"> is blocked (WKWebView).
 */

import { FastifyInstance } from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultLogger as logger } from '../../utils/logger';

/**
 * Register file dialog routes on a Fastify instance
 */
export async function registerFileDialogRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/browse-files?dir=/path/to/dir
   *
   * Returns directory listing for the in-overlay file picker.
   * Defaults to the user's home directory.
   */
  fastify.get('/api/browse-files', async (request, reply) => {
    const { dir } = request.query as { dir?: string };
    const targetDir = dir || os.homedir();

    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: path.join(targetDir, e.name),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const parent = path.dirname(targetDir);
      reply.send({
        path: targetDir,
        parent: parent !== targetDir ? parent : null,
        entries,
      });
    } catch {
      reply.code(400).send({ error: 'Cannot read directory' });
    }
  });

  /**
   * POST /api/read-file { path: string }
   *
   * Reads a file from the filesystem and returns it as base64.
   * Used by the in-overlay file picker to hand off the selected file.
   */
  fastify.post('/api/read-file', async (request, reply) => {
    const { path: filePath } = request.body as { path: string };

    if (!filePath) {
      return reply.code(400).send({ error: 'path is required' });
    }

    try {
      const base64 = fs.readFileSync(filePath).toString('base64');
      reply.send({ name: path.basename(filePath), base64 });
    } catch {
      reply.code(400).send({ error: 'Cannot read file' });
    }
  });

  logger.debug('[FileDialog] Registered file browse routes');
}
