/**
 * Shared word-actions logic
 *
 * Core functions for pre-review checks and document saving via the word-actions Rust binary.
 * Used by both HTTP API routes and IPC handlers.
 */

import { execFile, spawn } from 'child_process';
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
 * Run AppleScript via stdin instead of -e flag.
 * Use this for scripts with long strings that exceed shell argument limits.
 * Pipes the script to `osascript` via stdin — no temp files needed.
 */
function runAppleScriptStdin(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/osascript', [], { timeout: 15000 });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `osascript exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    proc.on('error', (err) => reject(err));

    proc.stdin.write(script);
    proc.stdin.end();
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
      const errMsg = (asErr as Error).message || '';
      logger.error('[WordActions] AppleScript saved-check error:', asErr);
      if (errMsg.includes('-1743') || errMsg.includes('Not authorized')) {
        return {
          canProceed: false,
          reason: 'permission_denied',
          message: 'Unable to check for unsaved changes. Remember to save before reviewing.',
        };
      }
      return { canProceed: true }; // fail-open for other errors
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

export type WordMethod = 'applescript' | 'keyboard';
export type InsertMethod = WordMethod;

export interface InsertParagraphResult {
  success: boolean;
  error?: string;
}

/**
 * Insert a paragraph at the current cursor position.
 *
 * @param content The text to insert
 * @param position How the cursor was positioned:
 *   - 'after': cursor is after previous text → Enter, then paste content
 *   - 'before': cursor is before next text → paste content, then Enter
 */
export async function insertParagraphInWord(
  content: string,
  position: CursorPositionType = 'after',
  disableBlueInsertion?: boolean
): Promise<InsertParagraphResult> {
  logger.info(`[WordActions] insertParagraphInWord called with position: ${position}`);

  try {
    const escapedContent = content
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');

    const enterThenPaste = `
      keystroke return
      delay 0.1
      keystroke "v" using command down`;

    const pasteThenEnter = `
      keystroke "v" using command down
      delay 0.1
      keystroke return`;

    const keySequence = position === 'after' ? enterThenPaste : pasteThenEnter;

    const script = `
set theContent to "${escapedContent}"
tell application "Microsoft Word" to activate
delay 0.3
do shell script "printf '%s' " & quoted form of theContent & " | pbcopy"
delay 0.1
tell application "System Events"
  ${keySequence}
end tell
delay 0.1
tell application "Microsoft Word"
  set style of text object of selection to "Normal"${disableBlueInsertion ? '' : `
  set selObj to selection
  set endPos to selection end of selObj
  set startPos to endPos - ${content.length}
  set myRange to create range active document start startPos end endPos
  select myRange
  set theFont to get font object of selection
  set color of theFont to {0, 0, 65535}
  selection end of selObj`}
end tell`;

    await runAppleScript(script);
    return { success: true };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] insertParagraphInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export interface ApplyStyleResult {
  success: boolean;
  error?: string;
}

/**
 * Apply a named style to the current selection in Word.
 */
export async function applyStyleInWord(style: string): Promise<ApplyStyleResult> {
  logger.info(`[WordActions] applyStyleInWord called with style: ${style}`);

  try {
    const escapedStyle = style.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `tell application "Microsoft Word"
  set style of text object of selection to "${escapedStyle}"
end tell`;

    await runAppleScript(script);
    return { success: true };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] applyStyleInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export interface ApplyFormattingOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  allCaps?: boolean;
  smallCaps?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  color?: string;
}

export interface ApplyFormattingResult {
  success: boolean;
  error?: string;
}

/**
 * Apply character-level formatting to the current selection in Word.
 */
export async function applyFormattingInWord(options: ApplyFormattingOptions): Promise<ApplyFormattingResult> {
  logger.info(`[WordActions] applyFormattingInWord called with options: ${JSON.stringify(options)}`);

  const propertyMap: Record<string, string> = {
    bold: 'bold',
    italic: 'italic',
    underline: 'underline',
    strikethrough: 'strikethrough',
    allCaps: 'all caps',
    smallCaps: 'small caps',
    superscript: 'superscript',
    subscript: 'subscript',
  };

  const lines: string[] = [];
  for (const [key, wordProp] of Object.entries(propertyMap)) {
    const value = options[key as keyof ApplyFormattingOptions];
    if (value !== undefined) {
      lines.push(`  set ${wordProp} of font object of selection to ${value}`);
    }
  }

  if (options.color !== undefined) {
    const hex = options.color.replace(/^#/, '');
    const r8 = parseInt(hex.substring(0, 2), 16);
    const g8 = parseInt(hex.substring(2, 4), 16);
    const b8 = parseInt(hex.substring(4, 6), 16);
    if (isNaN(r8) || isNaN(g8) || isNaN(b8)) {
      return { success: false, error: `Invalid hex color: ${options.color}` };
    }
    // Word AppleScript uses 16-bit color values (0-65535)
    const r = r8 * 257;
    const g = g8 * 257;
    const b = b8 * 257;
    lines.push(`  set theFont to get font object of selection`);
    lines.push(`  set color of theFont to {${r}, ${g}, ${b}}`);
  }

  if (lines.length === 0) {
    return { success: false, error: 'No formatting properties provided' };
  }

  try {
    const script = `tell application "Microsoft Word"\n${lines.join('\n')}\nend tell`;
    await runAppleScript(script);
    return { success: true };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] applyFormattingInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export interface GetFilePathResult {
  success: boolean;
  error?: string;
  filePath?: string;
  fileName?: string;
}

export interface OpenDocumentResult {
  success: boolean;
  error?: string;
  fileName?: string;
}

/**
 * Open (or focus) a Word document by file path, making it the active document.
 */
export async function openWordDocument(filePath: string): Promise<OpenDocumentResult> {
  logger.info('[WordActions] openWordDocument called', { filePath });

  try {
    const script = `tell application "Microsoft Word"
  activate
  open "${filePath.replace(/"/g, '\\"')}"
  delay 2
  set doc to active document
  set docName to name of doc
  return docName
end tell`;

    const result = await runAppleScriptStdin(script);
    return { success: true, fileName: result };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] openWordDocument error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Get the file path of the active Word document.
 */
export async function getWordFilePath(): Promise<GetFilePathResult> {
  logger.info('[WordActions] getWordFilePath called');

  try {
    const script = `tell application "Microsoft Word"
  if (count of documents) is 0 then
    error "No documents are open"
  end if
  set doc to active document
  set docName to name of doc
  set docPath to full name of doc
  return docPath & "||" & docName
end tell`;

    const result = await runAppleScript(script);
    const [filePath, fileName] = result.split('||');
    return { success: true, filePath, fileName };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] getWordFilePath error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export interface SaveDocumentResult {
  success: boolean;
  error?: string;
}

/**
 * Save the active Word document.
 */
export async function saveWordDocument(): Promise<SaveDocumentResult> {
  logger.info('[WordActions] saveWordDocument called');

  try {
    const script = `tell application "Microsoft Word"
  if (count of documents) is 0 then
    error "No documents are open"
  end if
  set doc to active document
  save doc
end tell`;

    await runAppleScript(script);
    return { success: true };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] saveWordDocument error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

// Default chunk size: ~8000 chars ≈ ~2000 tokens, fits comfortably in LLM context
const DEFAULT_GET_TEXT_LIMIT = 8000;

export interface GetTextResult {
  success: boolean;
  error?: string;
  fileName?: string;
  totalLength?: number;
  offset?: number;
  limit?: number;
  content?: string;
  hasMore?: boolean;
}

/**
 * Get the current text content of the active Word document (including unsaved changes).
 * Supports pagination via offset/limit to handle large documents.
 *
 * @param offset Character offset to start reading from (0-based, default 0)
 * @param limit Max characters to return (default 8000)
 */
export async function getWordText(offset: number = 0, limit: number = DEFAULT_GET_TEXT_LIMIT): Promise<GetTextResult> {
  logger.info(`[WordActions] getWordText called: offset=${offset}, limit=${limit}`);

  try {
    const script = `tell application "Microsoft Word"
  if (count of documents) is 0 then
    error "No documents are open"
  end if
  set doc to active document
  set docName to name of doc
  set docContent to content of text object of doc
  set totalLen to length of docContent
  return docName & "||" & (totalLen as text) & "||" & docContent
end tell`;

    const result = await runAppleScriptStdin(script);

    // Parse: name||totalLength||content
    const firstSep = result.indexOf('||');
    const secondSep = result.indexOf('||', firstSep + 2);
    const fileName = result.substring(0, firstSep);
    const totalLength = parseInt(result.substring(firstSep + 2, secondSep), 10);
    const fullContent = result.substring(secondSep + 2);

    // Apply offset/limit
    const sliced = fullContent.substring(offset, offset + limit);
    const hasMore = offset + limit < fullContent.length;

    return {
      success: true,
      fileName,
      totalLength,
      offset,
      limit,
      content: sliced,
      hasMore,
    };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] getWordText error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export interface GetSelectionResult {
  success: boolean;
  error?: string;
  selectedText?: string;
}

/**
 * Get the currently selected text in Word.
 */
export async function getWordSelection(): Promise<GetSelectionResult> {
  logger.info('[WordActions] getWordSelection called');

  try {
    const script = `tell application "Microsoft Word"
  set sel to selection
  return content of text object of sel
end tell`;

    const result = await runAppleScript(script);
    return { success: true, selectedText: result };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] getWordSelection error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export interface AnchorText {
  before: string;
  target: string;
  after: string;
}

export type CursorPositionType = 'before' | 'after';

export interface PositionCursorResult {
  success: boolean;
  error?: string;
}

/**
 * Position the cursor before or after the anchor text in the active Word document.
 * Uses Cmd+F to find the text, then moves cursor left (before) or right (after).
 *
 * @param anchor The anchor text to search for
 * @param type 'before' = cursor placed before the anchor text, 'after' = cursor placed after it
 */
export async function positionCursorInWord(
  anchor: string,
  type: CursorPositionType = 'after',
): Promise<PositionCursorResult> {
  logger.info(`[WordActions] positionCursorInWord: type=${type}, anchor length ${anchor.length}`);

  if (!anchor || anchor.trim() === '') {
    return { success: false, error: 'anchor text is required' };
  }

  // For 'after': use last 60 chars (cursor goes after the match)
  // For 'before': use first 60 chars (cursor goes before the match)
  const searchText = type === 'after'
    ? (anchor.length > 60 ? anchor.substring(anchor.length - 60) : anchor)
    : (anchor.length > 60 ? anchor.substring(0, 60) : anchor);

  const escaped = searchText
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  // key code 124 = Right arrow (after match), key code 123 = Left arrow (before match)
  const arrowKeyCode = type === 'after' ? 124 : 123;

  try {
    const script = `
tell application "Microsoft Word" to activate
delay 0.3
tell application "System Events"
  keystroke "f" using command down
  delay 0.3
  keystroke "a" using command down
  delay 0.1
  keystroke "${escaped}"
  delay 0.1
  keystroke return
  delay 0.2
  key code 53
  delay 0.1
  key code ${arrowKeyCode}
end tell`;

    await runAppleScript(script);
    return { success: true };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] positionCursorInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export interface SelectTextResult {
  success: boolean;
  error?: string;
  selectedText?: string;
  iterations?: number;
  exact?: boolean;
}

/**
 * Select text in the active Word document using keyboard-only binary search:
 * 1. Cmd+F to find first 60 chars, Left arrow to place cursor at start
 * 2. Shift+Right arrow N times to extend selection
 * 3. Read selection via AppleScript, compare with target
 * 4. If under-selected: Shift+Right more. If over-selected: Shift+Left.
 * 5. Repeat (binary search) until match or 10 iterations.
 *
 * @param text The full text to select
 */
export async function selectTextInWord(
  text: string,
): Promise<SelectTextResult> {
  logger.info(`[WordActions] selectTextInWord: text length ${text.length}`);

  if (!text || text.trim() === '') {
    return { success: false, error: 'text is required' };
  }

  try {
    // Step 1: Position cursor at start of target text using Cmd+F
    const searchPrefix = text.length > 60 ? text.substring(0, 60) : text;
    const escapedPrefix = searchPrefix
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');

    const positionScript = `
tell application "Microsoft Word" to activate
delay 0.3
tell application "System Events"
  keystroke "f" using command down
  delay 0.3
  keystroke "a" using command down
  delay 0.1
  keystroke "${escapedPrefix}"
  delay 0.1
  keystroke return
  delay 0.3
  key code 53
  delay 0.3
  key code 123
end tell`;

    await runAppleScript(positionScript);

    // Step 2: Binary search using Shift+Arrow keys
    // Arrow key presses don't map 1:1 to characters (Word skips invisible formatting).
    // Track total presses and actual char count separately, using the ratio to estimate.
    const targetLen = text.length;
    let totalPresses = 0; // total arrow key presses from cursor start
    let lastSelectedText = '';
    let exact = false;
    const maxIterations = 12;
    let iteration = 0;

    // Initial estimate: press targetLen/2 arrows (ratio starts at 1:1)
    let nextPresses = Math.floor(targetLen / 2);

    for (iteration = 0; iteration < maxIterations; iteration++) {
      const delta = nextPresses - totalPresses;

      if (delta !== 0) {
        const absDelta = Math.abs(delta);
        const extend = delta > 0;

        if (absDelta > 200) {
          // Use Shift+Down/Up for large jumps (one line at a time with delay, batched in one script)
          const lineKeyCode = extend ? 125 : 126; // Down : Up
          const estimatedLines = Math.max(1, Math.ceil(absDelta / 80)); // ~80 chars per line
          const batchSize = 5;
          const batches = Math.ceil(estimatedLines / batchSize);
          const lineScript = `
tell application "Microsoft Word" to activate
delay 0.2
tell application "System Events"
  repeat ${batches} times
    repeat ${Math.min(batchSize, estimatedLines)} times
      key code ${lineKeyCode} using shift down
    end repeat
    delay 0.2
  end repeat
end tell`;
          await runAppleScript(lineScript);
        } else {
          // Use Shift+Right/Left for fine adjustments
          const keyCode = extend ? 124 : 123; // Right : Left
          const arrowScript = `
tell application "Microsoft Word" to activate
delay 0.1
tell application "System Events"
  repeat ${absDelta} times
    key code ${keyCode} using shift down
  end repeat
end tell`;
          await runAppleScript(arrowScript);
        }
        totalPresses = nextPresses;
      }

      // Wait for Word to update the selection before reading
      await new Promise(resolve => setTimeout(resolve, 200));

      // Read what's currently selected
      const readScript = `tell application "Microsoft Word"
  return content of text object of selection
end tell`;
      const rawSelectedText = await runAppleScript(readScript);
      // Strip invisible chars (page breaks, section breaks, form feeds) that Word
      // inserts when a selection spans multiple pages
      lastSelectedText = rawSelectedText.replace(/[\n\r\f\v\x0c\x0b\x0e\x0f]/g, '');
      const actualLen = lastSelectedText.length;

      logger.info(`[WordActions] selectTextInWord iteration ${iteration + 1}: presses=${totalPresses}, raw=${rawSelectedText.length}, cleaned=${actualLen}, target=${targetLen}`);

      if (lastSelectedText === text) {
        exact = true;
        break;
      }

      // Log where startsWith diverges for debugging
      if (actualLen > 0 && !text.startsWith(lastSelectedText)) {
        const minLen = Math.min(actualLen, targetLen);
        let divergeIdx = 0;
        for (let i = 0; i < minLen; i++) {
          if (lastSelectedText[i] !== text[i]) {
            divergeIdx = i;
            break;
          }
        }
        if (divergeIdx > 0 || (minLen > 0 && lastSelectedText[0] !== text[0])) {
          const selSnippet = lastSelectedText.substring(divergeIdx, divergeIdx + 20);
          const targetSnippet = text.substring(divergeIdx, divergeIdx + 20);
          const selCodes = Array.from(selSnippet).map(c => c.charCodeAt(0));
          const targetCodes = Array.from(targetSnippet).map(c => c.charCodeAt(0));
          logger.info(`[WordActions] selectTextInWord diverge at ${divergeIdx}: sel=${JSON.stringify(selSnippet)} (${selCodes}), target=${JSON.stringify(targetSnippet)} (${targetCodes})`);
        }
      }

      // Use observed ratio of presses-to-chars to estimate next press count
      const ratio = totalPresses > 0 && actualLen > 0 ? totalPresses / actualLen : 1;

      if (text.startsWith(lastSelectedText) && actualLen < targetLen) {
        // Under-selected: estimate presses needed for remaining chars
        const charsNeeded = targetLen - actualLen;
        const pressesNeeded = Math.max(1, Math.ceil(charsNeeded * ratio));
        // When close (< 100 chars), go direct; otherwise halve to avoid overshoot
        nextPresses = totalPresses + (charsNeeded < 100 ? pressesNeeded : Math.max(1, Math.ceil(pressesNeeded / 2)));
      } else if (actualLen > targetLen || !text.startsWith(lastSelectedText)) {
        // Over-selected or wrong content: shrink
        const charsOver = actualLen - targetLen;
        const pressesToShrink = Math.max(1, Math.ceil(Math.abs(charsOver) * ratio));
        nextPresses = totalPresses - (Math.abs(charsOver) < 100 ? pressesToShrink : Math.max(1, Math.ceil(pressesToShrink / 2)));
        if (nextPresses < 1) nextPresses = 1;
      } else {
        // Same length but different content — try +1
        nextPresses = totalPresses + 1;
      }
    }

    return {
      success: true,
      selectedText: lastSelectedText,
      iterations: iteration + 1,
      exact,
    };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] selectTextInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export interface DeleteSelectionResult {
  success: boolean;
  error?: string;
  deletedText?: string;
}

/**
 * Delete the current selection in Word.
 */
export async function deleteSelectionInWord(): Promise<DeleteSelectionResult> {
  logger.info('[WordActions] deleteSelectionInWord');

  try {
    const script = `
tell application "Microsoft Word" to activate
delay 0.2
tell application "System Events"
  key code 51
end tell`;

    await runAppleScript(script);
    return { success: true };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] deleteSelectionInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
