import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveActiveGoogleDocInfo, documentPathToGoogleDocId } from '../hostApps/googleDocsHostApp';
import { isConnected as isGoogleDocsApiConnected, getDocText as getDocTextViaApi } from '../googleDocsService';

// Default to a large window so the common case (read the whole doc once) is a
// single tool call. Agents tend to forget to paginate, and reporting "the doc
// cuts off here" when we ourselves truncated it is worse than returning a long
// body. Pagination is still available via explicit offset/limit.
const DEFAULT_GET_TEXT_LIMIT = 200_000;

/**
 * MCP server exposing Google Docs operations to the agent.
 *
 * - `get_active_doc` — returns the active doc's synthetic path and display
 *   title. The Rust window monitor detects the active browser tab URL natively.
 * - `get_text` — reads the full doc body via the Google Docs API with
 *   offset/limit pagination. Requires Google OAuth connection.
 * - `find_and_replace` — proposal-only edit suggestion. Apply is through the
 *   Docs API when the user has connected Google.
 */
export async function googleDocsGetActiveDoc(_args: any = {}) {
  try {
    const info = resolveActiveGoogleDocInfo();
    if (!info) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No active Google Doc — the focused browser tab is not a Google Doc. Ask the user to switch to a Google Doc tab in Chrome or Safari.',
            }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            documentPath: info.documentPath,
            title: info.title,
            url: info.url,
          }),
        },
      ],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
  }
}

export async function googleDocsGetText(args: { selection_only?: boolean; offset?: number; limit?: number } = {}) {
  try {
    if (args.selection_only) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Selection reading is not currently available for Google Docs. Read the full document instead by calling get_text without selection_only.',
            }),
          },
        ],
      };
    }

    if (!isGoogleDocsApiConnected()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Full-document reads require connecting Google in Settings → Google Docs Integration.',
              reason: 'oauth-required',
            }),
          },
        ],
      };
    }
    const info = resolveActiveGoogleDocInfo();
    const docId = info ? documentPathToGoogleDocId(info.documentPath) : null;
    if (!docId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No active Google Doc — the focused browser tab is not a Google Doc. Ask the user to focus the Doc tab and try again.',
            }),
          },
        ],
      };
    }
    const apiResult = await getDocTextViaApi(docId);
    if (!apiResult.success || !apiResult.data) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: apiResult.error ?? 'Docs API call failed',
              reason: apiResult.authExpired ? 'auth-expired' : undefined,
            }),
          },
        ],
      };
    }
    const fullText = apiResult.data.text;
    if (!fullText) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'The Docs API returned an empty body for this document. The doc may be empty.',
            }),
          },
        ],
      };
    }
    const offset = Math.max(0, args.offset ?? 0);
    const limit = Math.max(1, args.limit ?? DEFAULT_GET_TEXT_LIMIT);
    const slice = fullText.substring(offset, offset + limit);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            text: slice,
            offset,
            limit,
            totalLength: fullText.length,
            truncated: offset + limit < fullText.length,
          }),
        },
      ],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text' as const, text: String(err) }] };
  }
}

export async function googleDocsFindAndReplace(args: { search_text: string; replacement_text: string; replace_scope?: 'first' | 'all'; match_case?: boolean }) {
  const info = resolveActiveGoogleDocInfo();
  if (!info) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: 'No active Google Doc — cannot propose an edit without knowing which doc to scope the suggestion to.',
          }),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          proposed: true,
          document_path: info.documentPath,
          search_text: args.search_text,
          replacement_text: args.replacement_text,
          replace_scope: args.replace_scope ?? 'first',
          match_case: args.match_case ?? true,
        }),
      },
    ],
  };
}

export function createGoogleDocsMcpServer() {
  return createSdkMcpServer({
    name: 'google-docs',
    tools: [
      tool(
        'get_active_doc',
        "Get the document path and display title of the Google Doc currently open in the user's focused browser tab (Chrome or Safari). Returns success=false when no Google Doc is active.",
        {},
        googleDocsGetActiveDoc,
      ),

      tool(
        'get_text',
        `Read the active Google Doc via the Google Docs API. Returns the full doc body in a single call (up to 200,000 characters). Optional offset/limit are available for paginating very long docs, but you should NOT need to paginate unless the response sets truncated=true. Documents with multiple tabs include all tab content.

Reads cover the entire saved document — no scrolling required. Very recently typed unsaved characters may lag by ~1–2 seconds (Docs autosave window). Comments are not included in the body.

If the response says \`truncated: false\`, you have the entire saved document — any "the doc ends here" claim should be about what the user has actually written, not about your read window.

Smart chips (people mentions, calendar events, linked files, etc.) appear as \`⟦...⟧\` in the returned text. These are NOT searchable plain text — the Docs API stores them as special inline objects. Never include \`⟦...⟧\` tokens in find_and_replace search_text; they will not match. Lines like "--- Tab: ... ---" are tab separators added by the reader and also do not exist in the doc.`,
        {
          selection_only: z.boolean().optional().describe("If true, return only the user's current selection (not the whole doc). Default: false."),
          offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0). Ignored when selection_only=true.'),
          limit: z.number().optional().describe(`Max characters to return (default ${DEFAULT_GET_TEXT_LIMIT}). Ignored when selection_only=true.`),
        },
        googleDocsGetText,
      ),

      tool(
        'find_and_replace',
        `Propose a text edit in the active Google Doc. The edit is applied via the Docs API when the user clicks Apply on the suggestion card. Call this tool once per edit. Do NOT describe the edits in your text — the UI shows them automatically.

IMPORTANT: The search_text must match the ACTUAL text in the Google Doc body.
- Never include \`⟦...⟧\` tokens in search_text — these represent smart chips (people, dates, calendar events, links) that are stored as special objects, not text.
- Never include "--- Tab: ... ---" lines — these are reader-added separators.
- Use short, unique snippets (a sentence or paragraph) as search_text, not large blocks.
- Build search_text only from plain text runs that appear BETWEEN smart chips.`,
        {
          search_text: z.string().describe('The exact text to find in the doc'),
          replacement_text: z.string().describe('The text to replace it with'),
          replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
          match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
        },
        googleDocsFindAndReplace,
      ),
    ],
  });
}
