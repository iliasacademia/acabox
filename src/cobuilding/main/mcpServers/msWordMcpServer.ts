import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  getWordFilePath,
  getWordText,
  getWordSelection,
  saveWordDocument,
  openWordDocument,
  positionCursorInWord,
  insertParagraphInWord,
  selectTextInWord,
  applyStyleInWord,
  applyFormattingInWord,
  deleteSelectionInWord,
  findAndReplaceInWord,
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
        'position_cursor',
        'Position the cursor before or after anchor text in the active Word document using Cmd+F.',
        {
          anchor: z.string().describe('The anchor text to search for. For type "after", use last ~60 chars of preceding text. For type "before", use first ~60 chars of following text.'),
          type: z.enum(['before', 'after']).describe('Where to place cursor relative to anchor: "before" = before the match, "after" = after the match'),
        },
        async (args) => {
          try {
            const result = await positionCursorInWord(args.anchor, args.type);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'insert_paragraph',
        'Insert a new paragraph at the current cursor position in Word.',
        {
          content: z.string().describe('The text content to insert'),
          position: z.enum(['before', 'after']).default('after').describe('Match this to the "type" used in position_cursor. "after" = Enter then paste. "before" = paste then Enter.'),
          defaultColor: z.string().optional().describe('Optional hex color for inserted text (e.g. "#0000FF")'),
        },
        async (args) => {
          try {
            const result = await insertParagraphInWord(args.content, args.position, args.defaultColor);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'select_text',
        'Find and select exact text in the active Word document using Cmd+F and binary search.',
        {
          text: z.string().describe('The exact text to select'),
        },
        async (args) => {
          try {
            const result = await selectTextInWord(args.text);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'apply_style',
        'Apply a named paragraph style to the current selection in Word. Use select_text first.',
        {
          style: z.string().describe('The style name (e.g. "Heading 1", "Normal", "Body Text")'),
        },
        async (args) => {
          try {
            const result = await applyStyleInWord(args.style);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'apply_formatting',
        'Apply character-level formatting to the current selection in Word. Use select_text first.',
        {
          bold: z.boolean().optional().describe('Set bold on/off'),
          italic: z.boolean().optional().describe('Set italic on/off'),
          underline: z.boolean().optional().describe('Set underline on/off'),
          strikethrough: z.boolean().optional().describe('Set strikethrough on/off'),
          allCaps: z.boolean().optional().describe('Set all caps on/off'),
          smallCaps: z.boolean().optional().describe('Set small caps on/off'),
          superscript: z.boolean().optional().describe('Set superscript on/off'),
          subscript: z.boolean().optional().describe('Set subscript on/off'),
          color: z.string().optional().describe('Text color as hex string (e.g. "#FF0000")'),
        },
        async (args) => {
          try {
            const result = await applyFormattingInWord(args);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'delete_selection',
        'Delete the current selection in the active Word document.',
        {},
        async () => {
          try {
            const result = await deleteSelectionInWord();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
          }
        },
      ),

      tool(
        'find_and_replace',
        'Find text in the active Word document and replace it. Uses Word\'s native find-and-replace — atomic, reliable, no keyboard simulation. Prefer this over the select_text + delete_selection + insert_paragraph sequence for text edits.',
        {
          search_text: z.string().describe('The exact text to find in the document'),
          replacement_text: z.string().describe('The text to replace it with'),
          replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
          match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
        },
        async (args) => {
          try {
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
    ],
  });
}
