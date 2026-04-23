import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  getWordFilePath,
  getWordText,
  getWordSelection,
  saveWordDocument,
  openWordDocument,
  findAndReplaceInWord,
  getTrackChangesStatus,
  setTrackChanges,
} from '../../../server/wordActions';

// Per-session edit approval state.
// 'ask' = require approval per edit, 'always' = auto-approve all edits this session
let editApprovalMode: 'ask' | 'always' = 'ask';

export function setEditApprovalMode(mode: 'ask' | 'always') {
  editApprovalMode = mode;
}

export function getEditApprovalMode() {
  return editApprovalMode;
}

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
        `Find text in the active Word document and replace it. When Track Changes is enabled, the edit appears as a tracked revision.

When the result contains "approval_required": true, the user must approve the edit before it's applied. Present the proposed change to the user and ask them to choose:
- "Allow once" → call find_and_replace again with approved: true
- "Always allow" → call find_and_replace with approved: true AND always_allow: true (auto-approves all subsequent edits this session)
- "Deny" → skip this edit

Do NOT call find_and_replace with approved: true unless the user has explicitly approved.`,
        {
          search_text: z.string().describe('The exact text to find in the document'),
          replacement_text: z.string().describe('The text to replace it with'),
          replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
          match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
          approved: z.boolean().optional().describe('Set to true only after user has approved the edit'),
          always_allow: z.boolean().optional().describe('Set to true when user chose "Always allow" — auto-approves all subsequent edits'),
        },
        async (args) => {
          try {
            // If user chose "always allow", switch to auto-approve mode
            if (args.always_allow) {
              editApprovalMode = 'always';
            }

            // In "ask" mode: require approval before executing
            if (editApprovalMode === 'ask' && !args.approved) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({
                approval_required: true,
                search_text: args.search_text,
                replacement_text: args.replacement_text,
                message: `Academia Coscientist wants to replace "${args.search_text.substring(0, 60)}${args.search_text.length > 60 ? '...' : ''}" with "${args.replacement_text.substring(0, 60)}${args.replacement_text.length > 60 ? '...' : ''}"`,
              }) }] };
            }

            const result = await findAndReplaceInWord(
              args.search_text,
              args.replacement_text,
              args.replace_scope,
              args.match_case,
            );
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
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
