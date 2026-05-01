/**
 * AppleScript-backed operations for Apple Notes (macOS).
 *
 * Mirrors the structure of wordActions.ts. All AppleScript runs in the Electron
 * main process — that's where macOS grants Apple Events permission for
 * `com.apple.Notes` (the user must approve once on first call).
 *
 * Apple Notes doesn't expose the file system; notes live in NoteStore.sqlite
 * and are referenced by stable `x-coredata://...` ids. We treat those ids as
 * the canonical "document path" for sessions and apply-edit dispatch via the
 * synthetic `applenotes://<id>` scheme.
 */

import { execFile, spawn } from 'child_process';
import { defaultLogger as logger } from '../utils/logger';

/**
 * Escape a string for safe embedding in an AppleScript "..." literal.
 * Same rules as wordActions.escapeAppleScriptString.
 */
function escapeAppleScriptString(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function runAppleScript(script: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function runAppleScriptStdin(script: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/osascript', [], { timeout: timeoutMs });
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

// ─── Synthetic document path scheme ────────────────────────────────

const APPLENOTES_PATH_SCHEME = 'applenotes://';

export function noteIdToDocumentPath(noteId: string): string {
  return `${APPLENOTES_PATH_SCHEME}${noteId}`;
}

export function documentPathToNoteId(documentPath: string | null | undefined): string | null {
  if (!documentPath) return null;
  if (!documentPath.startsWith(APPLENOTES_PATH_SCHEME)) return null;
  return documentPath.slice(APPLENOTES_PATH_SCHEME.length);
}

/**
 * Return true when the given Apple-Notes id looks well-formed. Apple stores
 * note ids as `x-coredata://<store-uuid>/ICNote/<local-id>` URLs. We don't
 * try to parse them deeply — we just accept anything that looks like a Notes
 * CoreData URL for the apply-edit boundary check.
 */
export function isValidNoteId(noteId: string | null | undefined): boolean {
  if (!noteId) return false;
  return /^x-coredata:\/\/[^/]+\/ICNote\//.test(noteId);
}

// ─── Read operations ───────────────────────────────────────────────

export interface ActiveNoteResult {
  success: boolean;
  error?: string;
  noteId?: string;
  noteName?: string;
}

/**
 * Get the currently selected note in Notes.app. When multiple notes are
 * selected, returns the first one. Returns success:false with no error when
 * no note is selected.
 */
export async function getActiveNote(): Promise<ActiveNoteResult> {
  try {
    const script = `
tell application "Notes"
  set sel to selection
  if (count of sel) is 0 then
    return "none||"
  end if
  set n to item 1 of sel
  set noteId to id of n
  set noteName to name of n
  return "ok||" & noteId & "||" & noteName
end tell`;
    const result = await runAppleScript(script);
    if (result.startsWith('none')) return { success: true };
    const parts = result.split('||');
    if (parts[0] !== 'ok' || parts.length < 3) {
      return { success: false, error: 'Unexpected AppleScript output' };
    }
    return { success: true, noteId: parts[1], noteName: parts.slice(2).join('||') };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

const DEFAULT_GET_TEXT_LIMIT = 8000;

export interface GetTextResult {
  success: boolean;
  error?: string;
  noteId?: string;
  noteName?: string;
  totalLength?: number;
  offset?: number;
  limit?: number;
  content?: string;
  hasMore?: boolean;
}

/**
 * Get the plain-text content of a note by id. Pagination via offset/limit.
 */
export async function getNotePlainText(noteId: string, offset = 0, limit = DEFAULT_GET_TEXT_LIMIT): Promise<GetTextResult> {
  if (!isValidNoteId(noteId)) {
    return { success: false, error: `Invalid note id: ${noteId}` };
  }
  try {
    const escapedId = escapeAppleScriptString(noteId);
    const script = `
tell application "Notes"
  set n to note id "${escapedId}"
  set noteName to name of n
  set p to plaintext of n
  return noteName & "||SEP||" & p
end tell`;
    const out = await runAppleScriptStdin(script);
    const sepIdx = out.indexOf('||SEP||');
    const noteName = sepIdx >= 0 ? out.slice(0, sepIdx) : '';
    const plaintext = sepIdx >= 0 ? out.slice(sepIdx + '||SEP||'.length) : out;
    const totalLength = plaintext.length;
    const sliced = plaintext.substring(offset, offset + limit);
    return {
      success: true,
      noteId,
      noteName,
      totalLength,
      offset,
      limit,
      content: sliced,
      hasMore: offset + limit < totalLength,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Edit operations ───────────────────────────────────────────────

export interface FindAndReplaceResult {
  success: boolean;
  error?: string;
  replacementsCount: number;
}

/**
 * Find and replace text inside a note's body. Operates on the HTML body via
 * AppleScript text-item-delimiter substitution. Plain-text matches that don't
 * cross HTML tag boundaries replace cleanly; matches inside tags or spanning
 * formatting boundaries may behave unexpectedly (rare for prose notes).
 *
 * Apple Notes auto-prepends the note's title as a `<div>` on body write; our
 * find/replace acts on the body string we read, which already includes that
 * title div on subsequent writes. We don't add, remove, or duplicate it —
 * Notes handles it.
 *
 * `replaceScope` of 'first' replaces only the first occurrence; 'all' replaces
 * every occurrence.
 */
export async function findAndReplaceInNote(
  noteId: string,
  searchText: string,
  replacementText: string,
  replaceScope: 'first' | 'all' = 'first',
  matchCase = true,
): Promise<FindAndReplaceResult> {
  if (!isValidNoteId(noteId)) {
    return { success: false, error: `Invalid note id: ${noteId}`, replacementsCount: 0 };
  }
  if (!searchText) {
    return { success: false, error: 'search_text is empty', replacementsCount: 0 };
  }

  try {
    const escapedId = escapeAppleScriptString(noteId);
    const escapedSearch = escapeAppleScriptString(searchText);
    const escapedReplace = escapeAppleScriptString(replacementText);
    const considerCase = matchCase ? 'true' : 'false';
    const replaceAll = replaceScope === 'all' ? 'true' : 'false';

    // We do find/replace in AppleScript directly via text-item-delimiters.
    // For case-insensitive matches we use AppleScript's `considering case`
    // block. For first-only we replace just the leading occurrence.
    const script = `
on replaceFirst(srcStr, oldText, newText)
  considering case
    set foundOffset to offset of oldText in srcStr
  end considering
  if foundOffset = 0 then return {srcStr, 0}
  set beforePart to text 1 thru (foundOffset - 1) of srcStr
  set afterStart to foundOffset + (length of oldText)
  if afterStart > (length of srcStr) then
    set afterPart to ""
  else
    set afterPart to text afterStart thru -1 of srcStr
  end if
  return {beforePart & newText & afterPart, 1}
end replaceFirst

on replaceAll(srcStr, oldText, newText)
  set AppleScript's text item delimiters to oldText
  set ti to text items of srcStr
  set replacementCount to (count of ti) - 1
  set AppleScript's text item delimiters to newText
  set joined to ti as text
  set AppleScript's text item delimiters to ""
  return {joined, replacementCount}
end replaceAll

tell application "Notes"
  set n to note id "${escapedId}"
  set oldBody to body of n
  set searchStr to "${escapedSearch}"
  set replaceStr to "${escapedReplace}"
  if ${replaceAll} then
    if ${considerCase} then
      considering case
        set replResult to my replaceAll(oldBody, searchStr, replaceStr)
      end considering
    else
      ignoring case
        set replResult to my replaceAll(oldBody, searchStr, replaceStr)
      end ignoring
    end if
  else
    if ${considerCase} then
      considering case
        set replResult to my replaceFirst(oldBody, searchStr, replaceStr)
      end considering
    else
      ignoring case
        set replResult to my replaceFirst(oldBody, searchStr, replaceStr)
      end ignoring
    end if
  end if
  set newBody to item 1 of replResult
  set replCount to item 2 of replResult
  if replCount > 0 then
    set body of n to newBody
  end if
  return "ok||" & replCount
end tell`;

    const out = await runAppleScriptStdin(script);
    const parts = out.split('||');
    if (parts[0] !== 'ok') {
      return { success: false, error: out, replacementsCount: 0 };
    }
    const count = parseInt(parts[1] ?? '0', 10) || 0;
    if (count === 0) {
      return { success: false, error: 'search_text not found', replacementsCount: 0 };
    }
    return { success: true, replacementsCount: count };
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown error';
    logger.error('[AppleNotesActions] findAndReplaceInNote error:', errorMessage);
    return { success: false, error: errorMessage, replacementsCount: 0 };
  }
}

/**
 * Apple Notes saves automatically — this is a no-op exposed for parity with
 * Word's `save_document` so the agent's mental model stays consistent.
 */
export async function saveNote(noteId: string): Promise<{ success: boolean; error?: string }> {
  if (!isValidNoteId(noteId)) {
    return { success: false, error: `Invalid note id: ${noteId}` };
  }
  return { success: true };
}

/**
 * Open a note by id — bring Notes.app to the foreground and select the note.
 */
export async function openNote(noteId: string): Promise<{ success: boolean; error?: string; noteName?: string }> {
  if (!isValidNoteId(noteId)) {
    return { success: false, error: `Invalid note id: ${noteId}` };
  }
  try {
    const escapedId = escapeAppleScriptString(noteId);
    const script = `
tell application "Notes"
  activate
  set n to note id "${escapedId}"
  show n
  return name of n
end tell`;
    const name = await runAppleScript(script);
    return { success: true, noteName: name };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Probe whether Apple Events permission for Notes.app is granted. Returns
 * true on success; false (with reason) when blocked. Used by the Settings
 * toggle's enable-flow as a secondary check after Accessibility permission.
 */
export async function checkNotesPermission(): Promise<{ granted: boolean; error?: string }> {
  try {
    await runAppleScript(`tell application "Notes" to count notes`);
    return { granted: true };
  } catch (err) {
    return { granted: false, error: (err as Error).message };
  }
}
