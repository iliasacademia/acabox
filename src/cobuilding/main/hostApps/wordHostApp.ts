import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { createMsWordMcpServer } from '../mcpServers/msWordMcpServer';
import { findAndReplaceInWord } from '../../../server/wordActions';
import type { HostApp, ApplyEditParams, ApplyEditResult, PreToolUseHook } from './types';

const WORD_BUNDLE_ID = 'com.microsoft.Word';

const WORD_FILE_EXTENSIONS = ['.doc', '.docx', '.docm', '.dotx', '.dotm', '.rtf'];

const WORD_ALLOWED_TOOLS = [
  'mcp__ms-word__get_file_path',
  'mcp__ms-word__get_text',
  'mcp__ms-word__get_selection',
  'mcp__ms-word__save_document',
  'mcp__ms-word__open_document',
  'mcp__ms-word__find_and_replace',
  'mcp__ms-word__track_changes_status',
  'mcp__ms-word__set_track_changes',
];

const WORD_SYSTEM_PROMPT_APPEND = `When the user wants to make edits or suggestions to a .docx file:

IMPORTANT: NEVER unpack, modify XML, or edit .docx files directly on disk. ALWAYS use the ms-word MCP tools.

1. Use mcp__ms-word__get_text to read the document content.
2. Use mcp__ms-word__find_and_replace to propose edits. Each edit must target a single sentence — do not span multiple sentences. Edits must not overlap with each other. Call the tool once per edit. The UI automatically renders a suggestion card with the diff and approve/deny buttons — do NOT describe or preview the edits in your text.
3. After proposing edits, say something brief like "I've proposed N edits — please review above." The user approves or denies each edit directly in the UI. Approved edits are applied as tracked revisions in Word.
4. Use mcp__ms-word__save_document to save after editing.

Track changes are managed automatically when edits are applied — do not call track_changes_status or set_track_changes. Do NOT use any other method to edit Word documents.`;

// Block direct .docx file manipulation — force use of ms-word MCP tools instead.
const docxProtectionHook: PreToolUseHook = async (input: HookInput): Promise<SyncHookJSONOutput> => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const { tool_name, tool_input } = input;
  const toolInput = (tool_input ?? {}) as Record<string, unknown>;

  const pathFields = ['file_path', 'path', 'command'];
  for (const field of pathFields) {
    const val = toolInput[field];
    if (typeof val === 'string' && (
      val.includes('.docx') && (
        tool_name === 'Bash' ? (val.includes('unzip') || val.includes('zip') || val.includes('docx')) :
        (tool_name === 'Read' || tool_name === 'Write' || tool_name === 'Edit')
      )
    )) {
      if (tool_name === 'Bash' && (val.includes('unzip') || val.includes('mkdir') || val.includes('zip '))) {
        return {
          decision: 'block',
          reason: 'Do not unpack or modify .docx files directly. Use the ms-word MCP tools (find_and_replace with Track Changes) to edit Word documents.',
        } as any;
      }
      if ((tool_name === 'Edit' || tool_name === 'Write') && (val.includes('document.xml') || val.includes('word/'))) {
        return {
          decision: 'block',
          reason: 'Do not edit .docx XML files directly. Use mcp__ms-word__find_and_replace with Track Changes enabled instead.',
        } as any;
      }
    }
  }
  return {};
};

export const wordHostApp: HostApp = {
  id: 'word',
  bundleId: WORD_BUNDLE_ID,
  displayName: 'Word',
  fileExtensions: WORD_FILE_EXTENSIONS,

  windowMonitorArgs() {
    return [
      '--bundle-id',
      WORD_BUNDLE_ID,
      '--track-text-selection',
      '--track-document-text',
      '--content-area-role',
      'AXSplitGroup',
    ];
  },

  resolveDocumentPath(window) {
    return window.documentPath ?? null;
  },

  mcpServerKey: 'ms-word',
  createMcpServer() {
    return createMsWordMcpServer();
  },

  allowedTools: WORD_ALLOWED_TOOLS,
  preToolHooks: [docxProtectionHook],
  systemPromptAppend: WORD_SYSTEM_PROMPT_APPEND,

  messagePrefix({ documentPath, selectedText }) {
    let prefix = '';
    if (documentPath) prefix += `Active Word document: ${documentPath}\n`;
    if (selectedText) {
      prefix += `The user has selected the following text in the document. Act ONLY on this selected text, not the entire document. If the user asks for a review or feedback, use the academic-writing-agent skill scoped to this selected passage.\n"""\n${selectedText}\n"""\n`;
    }
    return prefix;
  },

  async applyEdit(params: ApplyEditParams): Promise<ApplyEditResult> {
    const result = await findAndReplaceInWord(
      params.search_text,
      params.replacement_text,
      params.replace_scope || 'first',
      params.match_case ?? true,
    );
    return {
      success: result.success,
      error: result.error,
      replacementsCount: result.replacementsCount,
    };
  },
};
