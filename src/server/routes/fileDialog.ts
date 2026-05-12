/**
 * File dialog routes for the HTTP server
 *
 * Provides filesystem browsing endpoints for the in-overlay file picker,
 * used when HTML <input type="file"> is blocked (WKWebView).
 *
 * Security:
 * - Server only listens on 127.0.0.1 and requires a Bearer token (see auth middleware)
 * - Both endpoints additionally restrict access to the user's home directory and
 *   /Volumes (external drives on macOS) to prevent reading system files
 */

import { FastifyInstance } from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultLogger as logger } from '../../utils/logger';

const HOME_DIR = os.homedir();

/**
 * Returns true if the resolved path is within an allowed root.
 * Allowed: user home directory, /Volumes (macOS external drives).
 */
function isAllowedPath(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved.startsWith(HOME_DIR + path.sep) ||
    resolved === HOME_DIR ||
    resolved.startsWith('/Volumes/');
}

/**
 * Register file dialog routes on a Fastify instance
 */
export async function registerFileDialogRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/browse-files?dir=/path/to/dir
   *
   * Returns directory listing for the in-overlay file picker.
   * Defaults to the user's home directory. Restricted to home dir + /Volumes.
   */
  fastify.get('/api/browse-files', async (request, reply) => {
    const { dir } = request.query as { dir?: string };
    const targetDir = dir ? path.resolve(dir) : HOME_DIR;

    if (!isAllowedPath(targetDir)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && !e.name.startsWith('~$'))
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
      // Don't expose parent if it would be outside the allowed roots
      const allowedParent = parent !== targetDir && isAllowedPath(parent) ? parent : null;

      reply.send({
        path: targetDir,
        parent: allowedParent,
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
   * Restricted to home dir + /Volumes.
   */
  fastify.post('/api/read-file', async (request, reply) => {
    const { path: filePath } = request.body as { path: string };

    if (!filePath) {
      return reply.code(400).send({ error: 'path is required' });
    }

    const resolvedPath = path.resolve(filePath);

    if (!isAllowedPath(resolvedPath)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    try {
      const base64 = fs.readFileSync(resolvedPath).toString('base64');
      reply.send({ name: path.basename(resolvedPath), base64 });
    } catch {
      reply.code(400).send({ error: 'Cannot read file' });
    }
  });

  /**
   * POST /api/copy-to-workspace { sourcePath: string }
   *
   * Copies a file into the active workspace directory and returns the
   * workspace-relative path. Used by the overlay file picker so attachments
   * can be sent as lightweight file_reference instead of inline base64.
   */
  fastify.post('/api/copy-to-workspace', async (request, reply) => {
    const { sourcePath } = request.body as { sourcePath: string };
    if (!sourcePath) {
      return reply.code(400).send({ error: 'sourcePath is required' });
    }

    const resolvedSource = path.resolve(sourcePath);
    if (!isAllowedPath(resolvedSource)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    // Get workspace path from the app's window monitor service
    const { windowMonitorService } = require('../../windowMonitorService');
    const workspacePath = windowMonitorService.getActiveWorkspaceDirectory();
    if (!workspacePath) {
      return reply.code(400).send({ error: 'No active workspace' });
    }

    try {
      const fileName = path.basename(resolvedSource);
      const destPath = path.join(workspacePath, fileName);
      fs.copyFileSync(resolvedSource, destPath);
      reply.send({ relativePath: fileName });
    } catch {
      reply.code(400).send({ error: 'Cannot copy file' });
    }
  });

  logger.debug('[FileDialog] Registered file browse routes');
}
