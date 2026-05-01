import {
  findAndReplaceInNote,
  getActiveNote,
  noteIdToDocumentPath,
  documentPathToNoteId,
  isValidNoteId,
} from '../../../server/appleNotesActions';
import { defaultLogger as logger } from '../../../utils/logger';
import { createAppleNotesMcpServer } from '../mcpServers/appleNotesMcpServer';
import type { HostApp, ApplyEditParams, ApplyEditResult } from './types';

const APPLE_NOTES_BUNDLE_ID = 'com.apple.Notes';

const APPLE_NOTES_ALLOWED_TOOLS = [
  'mcp__apple-notes__get_active_note',
  'mcp__apple-notes__get_text',
  'mcp__apple-notes__save_note',
  'mcp__apple-notes__open_note',
  'mcp__apple-notes__find_and_replace',
];

const APPLE_NOTES_SYSTEM_PROMPT_APPEND = `When the user wants to make edits or suggestions to an Apple Note open in the Notes app:

IMPORTANT: NEVER attempt to read or modify Apple Notes via the file system. Apple Notes are not files — they live in the Notes database. ALWAYS use the apple-notes MCP tools so the user can review each change with an Approve/Deny card.

1. Call mcp__apple-notes__get_active_note to learn which note is in front of the user (returns its id and name).
2. Call mcp__apple-notes__get_text to read the note content as plain text.
3. Call mcp__apple-notes__find_and_replace to propose edits. Call the tool once per edit. The UI automatically renders a suggestion card with the diff and approve/deny buttons — do NOT describe or preview the edits in your text.
4. After proposing edits, say something brief like "I've proposed N edits — please review above." Approved edits are applied via AppleScript and appear in the Notes app immediately.

The user sees edits appear live in Notes once they approve. Find/replace operates on the note's HTML body — plain-text matches that don't cross formatting boundaries replace cleanly. The note's title (first line) is owned by Notes.app; avoid matching against it directly.`;

/**
 * Apple Notes "document path" is a synthetic URL: `applenotes://<note-id>`.
 * The note id is the AppleScript-exposed `x-coredata://...` URL.
 *
 * Unlike Word/Obsidian, Apple Notes content is NOT in the cobuilding workspace
 * folder — it lives in NoteStore.sqlite. The workspace is still used for the
 * agent's working state (cwd, container mount, skills, mini-apps) but the
 * note itself is an external resource. applyEdit therefore enforces a
 * scheme/id-shape boundary instead of a workspace-prefix boundary.
 */
async function appleNotesApplyEdit(params: ApplyEditParams): Promise<ApplyEditResult> {
  const { document_path, search_text, replacement_text, replace_scope, match_case } = params;
  const noteId = documentPathToNoteId(document_path ?? null);
  if (!noteId) {
    return {
      success: false,
      error: 'Apple Notes apply-edit requires document_path of the form applenotes://<note-id>',
      replacementsCount: 0,
    };
  }
  if (!isValidNoteId(noteId)) {
    return { success: false, error: `Invalid Apple Notes id: ${noteId}`, replacementsCount: 0 };
  }
  const result = await findAndReplaceInNote(
    noteId,
    search_text,
    replacement_text,
    (replace_scope as 'first' | 'all') || 'first',
    match_case ?? true,
  );
  if (result.success) {
    logger.info(`[AppleNotesHostApp] applied ${result.replacementsCount} replacement(s) to note ${noteId}`);
  }
  return result;
}

export const appleNotesHostApp: HostApp = {
  id: 'apple-notes',
  bundleId: APPLE_NOTES_BUNDLE_ID,
  displayName: 'Apple Notes',
  // No real file extensions — synthetic `applenotes://` paths. We keep the
  // array empty so `findHostAppForDocument` (extension-based) won't match this
  // host. `findHostAppForDocumentPath` resolves by URL scheme below.
  fileExtensions: [],

  windowMonitorArgs() {
    return [
      '--bundle-id',
      APPLE_NOTES_BUNDLE_ID,
      '--track-text-selection',
    ];
  },

  /**
   * Apple Notes doesn't expose AXDocument and there's no workspace-relative
   * path to compute. We resolve the active note's id on demand via AppleScript
   * and return it as `applenotes://<id>`. This call hits the OS each time it
   * runs; consumers that poll heavily should cache it themselves.
   */
  resolveDocumentPath() {
    return null;
  },

  mcpServerKey: 'apple-notes',
  createMcpServer() {
    return createAppleNotesMcpServer();
  },

  allowedTools: APPLE_NOTES_ALLOWED_TOOLS,
  systemPromptAppend: APPLE_NOTES_SYSTEM_PROMPT_APPEND,
  // Apple Notes doc paths all share the `applenotes://` scheme. When the
  // active note id isn't yet resolved, the overlay falls back to listing every
  // chat the user has had on Apple Notes.
  sessionDocumentPathLikePattern: 'applenotes://%',

  messagePrefix({ documentPath, selectedText }) {
    let prefix = '';
    if (documentPath) prefix += `Active Apple Note: ${documentPath}\n`;
    if (selectedText) {
      prefix += `The user has selected the following text in the note. Act ONLY on this selected text, not the entire note.\n"""\n${selectedText}\n"""\n`;
    }
    return prefix;
  },

  applyEdit: appleNotesApplyEdit,
};

/**
 * Async resolver for the focused note. Used by windowMonitorService when the
 * focused window's bundle id is `com.apple.Notes` — instead of returning null
 * (which `resolveDocumentPath` does to keep the contract synchronous), the
 * caller can await this to get the synthetic `applenotes://<id>` path.
 */
export async function resolveActiveAppleNotePath(): Promise<string | null> {
  try {
    const active = await getActiveNote();
    if (!active.success || !active.noteId) return null;
    return noteIdToDocumentPath(active.noteId);
  } catch {
    return null;
  }
}
