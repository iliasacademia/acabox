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
 * Run AppleScript via osascript.
 * Must be run from the Electron main process (not the Rust binary) because
 * macOS grants Apple Events permission per-binary, and only the Electron
 * app has Automation permission for Microsoft Word.
 */
function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Run pre-review check on a specific Word window.
 * Checks for duplicate window names and unsaved changes.
 * Fails open (returns canProceed: true) if the check itself errors.
 *
 * The Rust binary handles CGWindowList + AX API lookups and returns the
 * document filename. AppleScript (saved status check) runs here in the
 * Electron process which has Apple Events permission.
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

    // Duplicate name check (handled entirely in Rust)
    if (result.can_proceed === false) {
      return {
        canProceed: false,
        reason: result.reason,
        message: result.message,
      };
    }

    // If Rust couldn't get the doc filename, fail-open
    if (!result.doc_filename) {
      logger.info(`[WordActions] Pre-check skipped: ${result.skip_reason}`);
      return { canProceed: true };
    }

    // Check unsaved changes via AppleScript (runs in Electron process)
    const escaped = result.doc_filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Microsoft Word" to get (saved of document "${escaped}") as string`;
    try {
      const saved = await runAppleScript(script);
      if (saved !== 'true') {
        return {
          canProceed: false,
          reason: 'unsaved_changes',
          message: 'Reviewing requires saving the document.',
        };
      }
    } catch (asErr) {
      logger.error('[WordActions] AppleScript saved-check error:', asErr);
      return { canProceed: true }; // fail-open
    }

    return { canProceed: true };
  } catch (err) {
    logger.error('[WordActions] Pre-check error:', err);
    return { canProceed: true }; // fail-open
  }
}

/**
 * Save a Word document by name (no focus stealing).
 *
 * The Rust binary resolves the document filename via AX API.
 * AppleScript (save + verify) runs here in the Electron process
 * which has Apple Events permission.
 */
export async function wordSave(windowId: number): Promise<SaveResult> {
  try {
    // Get document filename from Rust binary
    const result = await runWordAction({
      action: 'save_by_name',
      window_id: windowId,
    });

    if (!result.success || !result.doc_filename) {
      return { success: false, error: result.error || 'Could not resolve document filename' };
    }

    const escaped = result.doc_filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Save via AppleScript
    try {
      await runAppleScript(`tell application "Microsoft Word" to save document "${escaped}"`);
    } catch (saveErr) {
      logger.error('[WordActions] AppleScript save error:', saveErr);
      return { success: false, error: `Save failed: ${(saveErr as Error).message}` };
    }

    // Verify saved status
    try {
      const saved = await runAppleScript(`tell application "Microsoft Word" to get (saved of document "${escaped}") as string`);
      if (saved !== 'true') {
        return { success: false, error: 'Document still has unsaved changes after save' };
      }
    } catch (verifyErr) {
      logger.error('[WordActions] AppleScript verify error:', verifyErr);
      return { success: false, error: `Could not verify save: ${(verifyErr as Error).message}` };
    }

    return { success: true };
  } catch (err) {
    logger.error('[WordActions] Save error:', err);
    return { success: false, error: 'Failed to execute save' };
  }
}
