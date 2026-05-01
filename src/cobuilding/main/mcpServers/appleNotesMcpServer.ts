import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  getActiveNote,
  getNotePlainText,
  listNotes,
  searchNotes,
  saveNote,
  openNote,
  noteIdToDocumentPath,
} from '../../../server/appleNotesActions';

/**
 * MCP server exposing Apple Notes operations to the agent.
 *
 * Mirrors the structure of msWordMcpServer.ts. `find_and_replace` is
 * proposal-only — the user approves each edit via the same Approve/Deny card
 * the Word/Obsidian flows use. The renderer's apply-edit POST routes to
 * `appleNotesHostApp.applyEdit()` based on the proposal's `document_path`,
 * which uses the synthetic `applenotes://<note-id>` scheme.
 */
export function createAppleNotesMcpServer() {
  return createSdkMcpServer({
    name: 'apple-notes',
    tools: [
      tool(
        'get_active_note',
        'Get the id and name of the currently selected note in Apple Notes. Returns null when no note is selected (e.g. user is on a folder view).',
        {},
        async () => {
          try {
            const result = await getActiveNote();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'get_text',
        'Get the plain-text content of an Apple Note. Defaults to the active note. Supports pagination via offset/limit.',
        {
          note_id: z.string().optional().describe('Apple Notes id (x-coredata://...). Defaults to the currently selected note.'),
          offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0)'),
          limit: z.number().optional().describe('Max characters to return (default 8000)'),
        },
        async (args) => {
          try {
            let noteId = args.note_id;
            if (!noteId) {
              const active = await getActiveNote();
              if (!active.success || !active.noteId) {
                return {
                  isError: true,
                  content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No active note' }) }],
                };
              }
              noteId = active.noteId;
            }
            const result = await getNotePlainText(noteId, args.offset, args.limit);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'list_notes',
        'List Apple Notes by most-recently-modified, paginated. Returns id, name, and modification date. Use this to enumerate notes when the user asks about all their notes.',
        {
          offset: z.number().optional().describe('Pagination offset (0-based, default 0)'),
          limit: z.number().optional().describe('Max notes to return (default 50)'),
        },
        async (args) => {
          try {
            const result = await listNotes(args.offset, args.limit);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'search_notes',
        "Search Apple Notes for a query string in note titles and bodies. Returns up to `limit` matches with id, name, and modification date. Backed by Apple's native search index — fast even across thousands of notes.",
        {
          query: z.string().describe('Text to search for in note titles and bodies'),
          limit: z.number().optional().describe('Max matches to return (default 50)'),
        },
        async (args) => {
          try {
            const result = await searchNotes(args.query, args.limit);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'save_note',
        "Save an Apple Note. Apple Notes saves automatically — this is a no-op kept for parity with the Word/Obsidian flow.",
        {
          note_id: z.string().optional().describe('Apple Notes id. Defaults to the active note.'),
        },
        async (args) => {
          try {
            let noteId = args.note_id;
            if (!noteId) {
              const active = await getActiveNote();
              if (!active.success || !active.noteId) {
                return {
                  isError: true,
                  content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No active note' }) }],
                };
              }
              noteId = active.noteId;
            }
            const result = await saveNote(noteId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'open_note',
        'Open (focus) a note in Apple Notes by id. Brings the Notes window forward and selects that note.',
        {
          note_id: z.string().describe('Apple Notes id (x-coredata://...).'),
        },
        async (args) => {
          try {
            const result = await openNote(args.note_id);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'find_and_replace',
        `Propose a text edit in an Apple Note. The edit is NOT applied immediately — the user sees a suggestion card and approves or denies each edit. Approved edits are applied via AppleScript and reflect immediately in the Notes app.

Call this tool once per edit. Do NOT describe the edits in your text — the UI shows them automatically.`,
        {
          search_text: z.string().describe('The exact text to find in the note'),
          replacement_text: z.string().describe('The text to replace it with'),
          replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
          match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
          note_id: z.string().optional().describe('Apple Notes id. Defaults to the active note.'),
        },
        async (args) => {
          let noteId = args.note_id;
          if (!noteId) {
            const active = await getActiveNote();
            if (!active.success || !active.noteId) {
              return {
                isError: true,
                content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No active note' }) }],
              };
            }
            noteId = active.noteId;
          }
          // Always return the proposal — never execute directly.
          // The UI renders a suggestion card with approve/deny buttons.
          // Approved edits are executed via /api/cobuilding/apply-edit which
          // dispatches to appleNotesHostApp.applyEdit().
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  proposed: true,
                  document_path: noteIdToDocumentPath(noteId),
                  search_text: args.search_text,
                  replacement_text: args.replacement_text,
                  replace_scope: args.replace_scope,
                  match_case: args.match_case,
                }),
              },
            ],
          };
        },
      ),
    ],
  });
}
