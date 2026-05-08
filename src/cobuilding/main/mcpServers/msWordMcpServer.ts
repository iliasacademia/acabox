import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  getWordFilePath,
  getWordText,
  getWordSelection,
  saveWordDocument,
  openWordDocument,
  getTrackChangesStatus,
  setTrackChanges,
} from '../../../server/wordActions';


export function createMsWordMcpServer() {
  return createSdkMcpServer({
    name: 'ms-word',
    tools: [
      tool(
        'get_file_path',
        'Get the file path and name of the active Word document.',
        {},
        async () => {
          try {
            const result = await getWordFilePath();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'get_text',
        'Get the text content of the active Word document. Supports pagination via offset/limit.',
        {
          offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0)'),
          limit: z.number().optional().describe('Max characters to return (default 8000)'),
        },
        async (args) => {
          try {
            const result = await getWordText(args.offset, args.limit);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'get_selection',
        'Get the currently selected text in the active Word document.',
        {},
        async () => {
          try {
            const result = await getWordSelection();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'save_document',
        'Save the active Word document.',
        {},
        async () => {
          try {
            const result = await saveWordDocument();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'open_document',
        'Open (or focus) a Word document by file path, making it the active document.',
        {
          path: z.string().describe('Absolute path to the .docx file to open'),
        },
        async (args) => {
          try {
            const result = await openWordDocument(args.path);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'find_and_replace',
        `Propose a text edit in the active Word document. The edit is NOT applied immediately — the user sees a suggestion card in the UI and approves or denies each edit. Only approved edits are applied as tracked revisions in Word.

Call this tool once per edit. Keep search_text to a single sentence — shorter searches match reliably even when the document has unaccepted tracked changes. Do NOT describe the edits in your text — the UI shows them automatically.`,
        {
          search_text: z.string().describe('The exact text to find in the document'),
          replacement_text: z.string().describe('The text to replace it with'),
          replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
          match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
        },
        async (args) => {
          // Always return the proposal — never execute directly.
          // The UI renders a suggestion card with approve/deny buttons.
          // Approved edits are executed via the apply-edit endpoint.
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            proposed: true,
            search_text: args.search_text,
            replacement_text: args.replacement_text,
            replace_scope: args.replace_scope,
            match_case: args.match_case,
          }) }] };
        },
      ),

      tool(
        'track_changes_status',
        'Check whether Track Changes is enabled on the active Word document. Always call this before making edits. If Track Changes is off, ask the user to enable it (Review tab → Track Changes) so edits appear as tracked revisions they can accept/reject.',
        {},
        async () => {
          try {
            const result = await getTrackChangesStatus();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'set_track_changes',
        'Enable or disable Track Changes on the active Word document.',
        {
          enabled: z.boolean().describe('true to enable Track Changes, false to disable'),
        },
        async (args) => {
          try {
            const result = await setTrackChanges(args.enabled);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

    ],
  });
}
