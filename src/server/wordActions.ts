/**
 * Shared word-actions logic
 *
 * Core functions for pre-review checks and document saving via the word-actions Rust binary.
 * Used by both HTTP API routes and IPC handlers.
 */

import { execFile } from 'child_process';
import path from 'path';
import { app } from 'electron';
import { defaultLogger as logger } from '../utils/logger';
import { logToWindowMonitorDb } from '../windowMonitorDb';

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

    logToWindowMonitorDb('word_actions_request', action);

    execFile(binPath, ['--json', jsonArg], { timeout: 10000 }, (error, stdout, stderr) => {
      if (stderr) {
        logger.info(`[WordActions] word-actions stderr: ${stderr}`);
      }
      if (error) {
        logger.error(`[WordActions] word-actions error:`, error);
        logToWindowMonitorDb('word_actions_response', { action: action.action, error: error.message });
        reject(new Error(`word-actions failed: ${error.message}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        logToWindowMonitorDb('word_actions_response', result);
        resolve(result);
      } catch (parseErr) {
        logToWindowMonitorDb('word_actions_response', { action: action.action, error: `parse error: ${stdout}` });
        reject(new Error(`Failed to parse word-actions output: ${stdout}`));
      }
    });
  });
}

export interface PreCheckResult {
  canProceed: boolean;
  reason?: string;
  message?: string;
}

export interface SaveResult {
  success: boolean;
  error?: string;
}

/**
 * Run pre-review check on a specific Word window.
 * Checks for duplicate window names and unsaved changes.
 * Fails open (returns canProceed: true) if the check itself errors.
 */
export async function reviewPreCheck(windowId: number): Promise<PreCheckResult> {
  logger.info(`[WordActions] Pre-check for window ID: ${windowId}`);

  try {
    const result = await runWordAction({
      action: 'pre_check',
      window_id: windowId,
    });

    logger.info(`[WordActions] Pre-check result:`, result);

    if (!result.success) {
      logger.error(`[WordActions] Pre-check failed: ${result.error}`);
      return { canProceed: true }; // fail-open
    }

    return {
      canProceed: result.can_proceed,
      reason: result.reason,
      message: result.message,
    };
  } catch (err) {
    logger.error('[WordActions] Pre-check error:', err);
    return { canProceed: true }; // fail-open
  }
}

/**
 * Save a Word document by name (no focus stealing).
 */
export async function wordSave(windowId: number): Promise<SaveResult> {
  try {
    const result = await runWordAction({
      action: 'save_by_name',
      window_id: windowId,
    });

    return {
      success: result.success,
      error: result.error,
    };
  } catch (err) {
    logger.error('[WordActions] Save error:', err);
    return { success: false, error: 'Failed to execute save' };
  }
}
