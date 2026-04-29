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
import { windowMonitorService } from '../windowMonitorService';

function getWordActionsBinPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'word-actions');
  }
  return path.join(app.getAppPath(), 'window-monitor', 'rust', 'target', 'release', 'word-actions');
}

/**
 * Escape a string for safe embedding in an AppleScript "..." literal.
 * Handles backslashes, double quotes, and characters (newlines, tabs)
 * that would break the string literal and allow injection.
 */
function escapeAppleScriptString(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ')
    // Remove control characters that break AppleScript
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Build an AppleScript string expression that preserves paragraph breaks.
 * Word uses \r for paragraph separators. This splits on newlines and joins
 * with AppleScript's `return` character via string concatenation.
 */
function buildAppleScriptString(input: string): string {
  const segments = input.split(/\r\n|\r|\n/);
  return segments.map((s) => '"' + escapeAppleScriptString(s) + '"').join(' & return & ');
}

const WORD_EXTENSIONS = new Set(['.doc', '.docx', '.docm', '.dotx', '.dotm', '.rtf']);

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
    const escaped = escapeAppleScriptString(result.doc_filename);
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

    const escaped = escapeAppleScriptString(result.doc_filename);

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
  defaultColor?: string
): Promise<InsertParagraphResult> {
  logger.info(`[WordActions] insertParagraphInWord called with position: ${position}`);

  windowMonitorService.suppressSelectionEvents(true);
  try {
    const enterThenPaste = `
      keystroke return
      delay 0.1
      keystroke "v" using command down`;

    const pasteThenEnter = `
      keystroke "v" using command down
      delay 0.1
      keystroke return`;

    const keySequence = position === 'after' ? enterThenPaste : pasteThenEnter;

    let colorBlock = '';
    if (defaultColor) {
      const hex = defaultColor.replace(/^#/, '');
      const r = parseInt(hex.substring(0, 2), 16) * 257;
      const g = parseInt(hex.substring(2, 4), 16) * 257;
      const b = parseInt(hex.substring(4, 6), 16) * 257;
      if (isNaN(r) || isNaN(g) || isNaN(b)) {
        return { success: false, error: `Invalid hex color: ${defaultColor}` };
      }
      colorBlock = `
  set selObj to selection
  set endPos to selection end of selObj
  set startPos to endPos - ${content.length}
  set myRange to create range active document start startPos end endPos
  select myRange
  set theFont to get font object of selection
  set color of theFont to {${r}, ${g}, ${b}}
  selection end of selObj`;
    }

    // Copy content to clipboard from Node.js — avoids embedding user
    // content in AppleScript, preventing injection attacks.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('/usr/bin/pbcopy', []);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`)));
      proc.on('error', reject);
      proc.stdin.write(content);
      proc.stdin.end();
    });

    const script = `
tell application "Microsoft Word" to activate
delay 0.3
tell application "System Events"
  tell process "Microsoft Word"
    ${keySequence}
  end tell
end tell
delay 0.1
tell application "Microsoft Word"
  set style of text object of selection to "Normal"${colorBlock}
end tell`;

    await runAppleScript(script);
    return { success: true };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] insertParagraphInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  } finally {
    windowMonitorService.suppressSelectionEvents(false);
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
    const escapedStyle = escapeAppleScriptString(style);

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

  // Validate file path to prevent path traversal and unauthorized file access
  const resolved = path.resolve(filePath);
  if (!path.isAbsolute(filePath)) {
    return { success: false, error: 'File path must be absolute' };
  }
  if (resolved !== filePath || filePath.includes('..')) {
    return { success: false, error: 'Invalid file path: path traversal not allowed' };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!WORD_EXTENSIONS.has(ext)) {
    return { success: false, error: `Unsupported file extension: ${ext}` };
  }

  try {
    const escapedPath = escapeAppleScriptString(filePath);
    const script = `tell application "Microsoft Word"
  activate
  open "${escapedPath}"
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

  windowMonitorService.suppressSelectionEvents(true);

  const cursorProperty = type === 'after' ? 'end' : 'start';

  try {
    // For 'after': use last N chars; for 'before': use first N chars
    const prefixLengths = [60, 30, 15];

    for (const len of prefixLengths) {
      const rawSearch = type === 'after'
        ? (anchor.length > len ? anchor.substring(anchor.length - len) : anchor)
        : (anchor.length > len ? anchor.substring(0, len) : anchor);
      const cleanSearch = rawSearch.replace(/[\r\n]+/g, ' ').trim();
      if (!cleanSearch) continue;

      for (const matchCase of [true, false]) {
        const searchExpr = '"' + escapeAppleScriptString(cleanSearch) + '"';
        const script = `
tell application "Microsoft Word"
  if (count of documents) is 0 then
    return "error||No document open"
  end if
  set doc to active document
  set docRange to create range doc start 0 end (end of content of text object of doc)
  set myFind to find object of docRange
  tell myFind
    set content to ${searchExpr}
    set forward to true
    set wrap to find stop
    set match case to ${matchCase}
  end tell
  set wasFound to execute find myFind
  if wasFound then
    set cursorPos to ${cursorProperty} of content of docRange
    set cursorRange to create range doc start cursorPos end cursorPos
    select cursorRange
    return "ok"
  else
    return "notfound"
  end if
end tell`;

        const result = await runAppleScriptStdin(script);
        if (result.startsWith('ok')) {
          logger.info(`[WordActions] positionCursorInWord: found with len=${len} matchCase=${matchCase}`);
          return { success: true };
        }
      }
    }

    return { success: false, error: 'Anchor text not found in document' };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] positionCursorInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  } finally {
    windowMonitorService.suppressSelectionEvents(false);
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

  // Suppress selection events so programmatic selections don't appear as user pills
  windowMonitorService.suppressSelectionEvents(true);
  try {
    // Use Word's native find object to locate the text, then extend the range
    // to the full target length and select it. Works in background without focus.
    const targetLen = text.length;

    // Try progressively shorter search prefixes and case-insensitive fallback.
    // Word's find object can fail on text with special formatting, field codes,
    // or paragraph marks, so we degrade gracefully.
    const prefixLengths = [
      Math.min(text.length, 60),
      Math.min(text.length, 30),
      Math.min(text.length, 15),
    ];

    for (const prefixLen of prefixLengths) {
      for (const matchCase of [true, false]) {
        // Strip paragraph breaks from the search prefix — Word's find object
        // uses ^p for paragraph marks, not literal returns.
        const rawPrefix = text.substring(0, prefixLen);
        const cleanPrefix = rawPrefix.replace(/[\r\n]+/g, ' ').trim();
        if (!cleanPrefix) continue;

        const searchExpr = '"' + escapeAppleScriptString(cleanPrefix) + '"';

        const script = `
tell application "Microsoft Word"
  if (count of documents) is 0 then
    return "error||No document open"
  end if
  set doc to active document
  set docRange to create range doc start 0 end (end of content of text object of doc)
  set myFind to find object of docRange
  tell myFind
    set content to ${searchExpr}
    set forward to true
    set wrap to find stop
    set match case to ${matchCase}
  end tell
  set wasFound to execute find myFind
  if not wasFound then
    return "notfound||"
  end if
  set foundStart to (start of content of docRange)
  set docEnd to (end of content of text object of doc)
  set selEnd to foundStart + ${targetLen}
  if selEnd > docEnd then set selEnd to docEnd
  set selRange to create range doc start foundStart end selEnd
  select selRange
  set selectedContent to content of text object of selection
  return "ok||" & selectedContent
end tell`;

        const result = await runAppleScriptStdin(script);
        const sepIdx = result.indexOf('||');
        const status = sepIdx >= 0 ? result.substring(0, sepIdx) : result;
        const payload = sepIdx >= 0 ? result.substring(sepIdx + 2) : '';

        if (status === 'ok' && payload) {
          const selectedText = payload.replace(/[\n\r\f\v\x0c\x0b\x0e\x0f]/g, '');
          const exact = selectedText === text;
          logger.info(`[WordActions] selectTextInWord: found with prefix=${prefixLen} matchCase=${matchCase}, selected ${selectedText.length} chars, exact=${exact}`);
          return { success: true, selectedText, iterations: 1, exact };
        }

        logger.info(`[WordActions] selectTextInWord: prefix=${prefixLen} matchCase=${matchCase} → not found, trying next`);
      }
    }

    return { success: false, error: 'Text not found in document after all search strategies' };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] selectTextInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  } finally {
    windowMonitorService.suppressSelectionEvents(false);
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

  windowMonitorService.suppressSelectionEvents(true);
  try {
    // Use Word's object model — works in background without focus
    const script = `
tell application "Microsoft Word"
  if (count of documents) is 0 then
    return "error||No document open"
  end if
  type text selection text ""
end tell`;

    await runAppleScriptStdin(script);
    return { success: true };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] deleteSelectionInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  } finally {
    windowMonitorService.suppressSelectionEvents(false);
  }
}

// ─── Find and Replace (Object Model) ────────────────────────────

export interface FindAndReplaceResult {
  success: boolean;
  error?: string;
  replacementsCount: number;
}

/**
 * Find and replace text in the active Word document using Word's native
 * find object. Single atomic operation — no keyboard simulation needed.
 */
// Serialize concurrent applies (e.g. "Approve all" fires N apply-edits in
// parallel). Word's find object is shared per-document, so interleaved
// AppleScript calls can clobber each other's search/replacement state.
let findReplaceQueue: Promise<unknown> = Promise.resolve();

export async function findAndReplaceInWord(
  searchText: string,
  replacementText: string,
  replaceScope: 'first' | 'all' = 'first',
  matchCase = true,
): Promise<FindAndReplaceResult> {
  const prev = findReplaceQueue;
  let release: () => void = () => {};
  findReplaceQueue = new Promise<void>((r) => { release = r; });
  await prev.catch(() => {});
  try {
    return await runFindAndReplace(searchText, replacementText, replaceScope, matchCase);
  } finally {
    release();
  }
}

async function runFindAndReplace(
  searchText: string,
  replacementText: string,
  replaceScope: 'first' | 'all',
  matchCase: boolean,
): Promise<FindAndReplaceResult> {
  logger.info(`[WordActions] findAndReplaceInWord scope=${replaceScope} matchCase=${matchCase}`);

  windowMonitorService.suppressSelectionEvents(true);
  try {
    const searchExpr = buildAppleScriptString(searchText);
    const replaceExpr = buildAppleScriptString(replacementText);
    const replaceAll = replaceScope === 'all';

    const script = `
tell application "Microsoft Word"
  if (count of documents) is 0 then
    return "error||No document open"
  end if
  try
    -- Temporarily set author name so tracked changes show "Academia Coscientist"
    set origName to user name
    set origInitials to user initials
    set user name to "Academia Coscientist"
    set user initials to "AC"
    set doc to active document
    -- Capture user's Track Changes mode and force ON for the apply so the edit
    -- is recorded as a tracked revision; restored before returning.
    set origTrack to track revisions of doc
    set track revisions of doc to true
    -- Use Word's native find/replace via the replacement object — this is the
    -- only pattern that handles tracked revisions cleanly. Setting content of
    -- a found range directly causes range-id failures and can collapse to
    -- replacing the whole document when revisions shift positions mid-edit.
    set findObj to find object of (text object of doc)
    set content of findObj to ${searchExpr}
    set forward of findObj to true
    set wrap of findObj to find stop
    set match case of findObj to ${matchCase}
    set replObj to replacement of findObj
    set content of replObj to ${replaceExpr}
    set wasFound to execute find findObj replace ${replaceAll ? 'replace all' : 'replace one'}
    if wasFound then
      set replacementsCount to 1
    else
      set replacementsCount to 0
    end if
    -- Restore original author name and Track Changes mode
    set user name to origName
    set user initials to origInitials
    set track revisions of doc to origTrack
    return "ok||" & replacementsCount
  on error errMsg number errNum
    -- Restore author name and Track Changes mode even on error
    try
      set user name to origName
      set user initials to origInitials
      set track revisions of doc to origTrack
    end try
    return "error||" & errMsg
  end try
end tell`;

    const result = await runAppleScriptStdin(script);
    const parts = result.split('||');

    if (parts[0] === 'error') {
      return { success: false, error: parts[1] || 'Unknown error', replacementsCount: 0 };
    }

    const count = parseInt(parts[1] || '0', 10);
    return { success: true, replacementsCount: count };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] findAndReplaceInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage, replacementsCount: 0 };
  } finally {
    windowMonitorService.suppressSelectionEvents(false);
  }
}

// ─── Track Changes ─────────────────────────────────────────────

export interface TrackChangesStatusResult {
  success: boolean;
  error?: string;
  enabled?: boolean;
}

/**
 * Check whether Track Changes is enabled on the active Word document.
 */
export async function getTrackChangesStatus(): Promise<TrackChangesStatusResult> {
  try {
    const script = `
tell application "Microsoft Word"
  if (count of documents) is 0 then
    return "error||No document open"
  end if
  if track revisions of active document then
    return "ok||true"
  else
    return "ok||false"
  end if
end tell`;
    const result = await runAppleScriptStdin(script);
    const parts = result.split('||');
    if (parts[0] === 'error') return { success: false, error: parts[1] };
    return { success: true, enabled: parts[1] === 'true' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Enable or disable Track Changes on the active Word document.
 */
export async function setTrackChanges(enabled: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    const script = `
tell application "Microsoft Word"
  if (count of documents) is 0 then
    return "error||No document open"
  end if
  set track revisions of active document to ${enabled}
  return "ok"
end tell`;
    const result = await runAppleScriptStdin(script);
    if (result.startsWith('error')) return { success: false, error: result.split('||')[1] };
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Reload Document ────────────────────────────────────────────

export interface ReloadDocumentResult {
  success: boolean;
  error?: string;
  filePath?: string;
}

/**
 * Reload the active Word document from disk.
 * Uses multiple strategies:
 * 1. Word's native 'revert' command (no close/reopen needed)
 * 2. Fallback: Cmd+F5 (Mac Word shortcut for revert)
 * 3. Fallback: close without saving + reopen
 */
export async function reloadDocumentInWord(): Promise<ReloadDocumentResult> {
  logger.info('[WordActions] reloadDocumentInWord');

  try {
    // Strategy 1: Use Word's revert command via AppleScript object model.
    // This is the cleanest — no close/reopen, no permission dialogs.
    const script = `
tell application "Microsoft Word"
  if (count of documents) is 0 then
    return "error||No document open"
  end if
  set doc to active document
  set docPath to full name of doc
  -- Word's revert discards in-memory changes and reloads from disk
  try
    revert doc
    return "ok||" & docPath
  on error errMsg
    -- Revert may fail if document was never saved or is read-only.
    -- Fall back to close + reopen.
    try
      close doc saving no
      delay 0.3
      open docPath
      return "ok||" & docPath
    on error errMsg2
      return "error||" & errMsg2
    end try
  end try
end tell`;

    const result = await runAppleScriptStdin(script);
    const sepIdx = result.indexOf('||');
    const status = sepIdx >= 0 ? result.substring(0, sepIdx) : result;
    const payload = sepIdx >= 0 ? result.substring(sepIdx + 2) : '';

    if (status === 'error') {
      return { success: false, error: payload || 'Unknown error' };
    }

    return { success: true, filePath: payload };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.info(`[WordActions] reloadDocumentInWord error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
