import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { browserExtensionServer } from '../../../server/browserExtensionServer';
import { resolveActiveGoogleDocInfo, documentPathToGoogleDocId } from '../hostApps/googleDocsHostApp';
import { isConnected as isGoogleDocsApiConnected, getDocText as getDocTextViaApi } from '../googleDocsService';

// Default to a large window so the common case (read the whole doc once) is a
// single tool call. Agents tend to forget to paginate, and reporting "the doc
// cuts off here" when we ourselves truncated it is worse than returning a long
// body. Pagination is still available via explicit offset/limit.
const DEFAULT_GET_TEXT_LIMIT = 200_000;

/**
 * MCP server exposing Google Docs operations to the agent. Read parity with
 * the Word host:
 *
 * - `get_active_doc` — returns the active doc's synthetic path, URL, and
 *   display title via the browser extension's WebSocket bridge.
 * - `get_text` — reads the full doc body (canvas-interception bridge in the
 *   extension forces a fresh extract before returning) with offset/limit
 *   pagination, or just the user's current selection when `selection_only` is
 *   true. Mirrors the Word `get_text` shape.
 * - `find_and_replace` — proposal-only edit suggestion. The renderer surfaces
 *   it as an Approve/Deny card, but Apply is gated by `googleDocsHostApp.applyEdit`
 *   which returns a Phase-C2 not-yet error until the OAuth + Docs API
 *   integration ships.
 */
export function createGoogleDocsMcpServer() {
  return createSdkMcpServer({
    name: 'google-docs',
    tools: [
      tool(
        'get_active_doc',
        "Get the document path, URL, and display title of the Google Doc currently open in the user's focused Chrome tab. Returns success=false when no Google Doc is active or the Academia browser extension is not connected.",
        {},
        async () => {
          try {
            const info = await resolveActiveGoogleDocInfo();
            if (!info) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      success: false,
                      error: 'No active Google Doc — either the browser extension is not connected, or the focused Chrome tab is not a Google Doc.',
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
        },
      ),

      tool(
        'get_text',
        `Read the active Google Doc. By default returns the full doc body in a single call (up to 200,000 characters) via Google Docs' own plain-text export endpoint, using the user's existing browser session. Optional offset/limit are available for paginating very long docs, but you should NOT need to paginate unless the response sets truncated=true. Pass \`selection_only: true\` to get just the user's current text selection instead.

Reads cover the entire saved document — no scrolling required. Very recently typed unsaved characters may lag by ~1–2 seconds (Docs autosave window). Comments are not included in the body. The \`selection_only\` path returns whatever Docs has currently highlighted.

If the response says \`truncated: false\`, you have the entire saved document — any "the doc ends here" claim should be about what the user has actually written, not about your read window.`,
        {
          selection_only: z.boolean().optional().describe("If true, return only the user's current selection (not the whole doc). Default: false."),
          offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0). Ignored when selection_only=true.'),
          limit: z.number().optional().describe(`Max characters to return (default ${DEFAULT_GET_TEXT_LIMIT}). Ignored when selection_only=true.`),
        },
        async (args) => {
          try {
            if (args.selection_only) {
              const text = await browserExtensionServer.getSelection(1500);
              if (!text) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({
                        success: false,
                        error: 'No text selected in the active tab. Ask the user to highlight the passage they want you to work on.',
                      }),
                    },
                  ],
                };
              }
              return {
                content: [
                  { type: 'text' as const, text: JSON.stringify({ success: true, text, selection: true }) },
                ],
              };
            }

            // Prefer the OAuth-backed Docs API when the user has connected it
            // — it handles multi-tab and download-restricted docs that the
            // extension's export-endpoint hack can't read. Fall back to the
            // extension when not connected (Phase A behavior).
            let fullText = '';
            let extensionReason: string | undefined;
            if (isGoogleDocsApiConnected()) {
              const info = await resolveActiveGoogleDocInfo();
              const docId = info ? documentPathToGoogleDocId(info.documentPath) : null;
              if (docId) {
                const apiResult = await getDocTextViaApi(docId);
                if (apiResult.success && apiResult.data) {
                  fullText = apiResult.data.text;
                } else if (apiResult.authExpired) {
                  return {
                    content: [
                      { type: 'text' as const, text: JSON.stringify({ success: false, error: apiResult.error, reason: 'auth-expired' }) },
                    ],
                  };
                } else if (apiResult.error) {
                  // Surface the API error but try the extension fallback first.
                  extensionReason = apiResult.error;
                }
              }
            }
            if (!fullText) {
              const docTextResult = await browserExtensionServer.getActiveGoogleDocText(4000);
              fullText = docTextResult?.text ?? '';
              if (!fullText) extensionReason = docTextResult?.reason ?? extensionReason;
            }
            const docTextResult = { text: fullText, reason: extensionReason } as { text: string; reason?: string };
            if (!fullText) {
              const reason = docTextResult.reason;
              let error: string;
              if (reason === 'multi-tab') {
                error = 'This is a multi-tab Google Doc (Document Tabs feature). Google\'s legacy plain-text export endpoint does not yet serve multi-tab docs — full-document reads on these require the upcoming OAuth + Docs API integration. For now you can still read the user\'s current selection by calling get_text with selection_only=true. Tell the user that whole-doc reads on tabbed Google Docs aren\'t supported yet, and ask them to highlight the passage they want you to work on.';
              } else if (reason === 'download-restricted') {
                error = 'Google returned 403/404 on the doc\'s plain-text export. The doc owner has likely disabled downloads (Drive: "Disable options to download, print, and copy for commenters and viewers"), or you do not have download permission. Full-doc reads aren\'t possible while that setting is on. You can still read the user\'s current selection via get_text with selection_only=true.';
              } else if (reason && reason.startsWith('export-status-')) {
                error = `Google's export endpoint returned ${reason.slice('export-status-'.length)} for this doc. Full-doc reads aren't possible right now. Use get_text with selection_only=true to work with the user's current selection.`;
              } else {
                error = "Could not read the Google Doc. The extension hasn't returned any text yet — usually because the doc tab was just reloaded and the content script isn't attached, or the extension isn't connected. Ask the user to focus the Doc tab in Chrome and try again. Selection reads (selection_only=true) usually work even when full-doc reads don't.";
              }
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ success: false, error, reason: reason ?? null }),
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
        },
      ),

      tool(
        'find_and_replace',
        `Propose a text edit in the active Google Doc. The edit is NOT applied automatically — the user sees a suggestion card with the diff. In Phase A v1 the user must apply the replacement manually inside Google Docs (the Apply button surfaces the planned Docs-API behavior; until OAuth ships it returns a not-yet error). Call this tool once per edit. Do NOT describe the edits in your text — the UI shows them automatically.`,
        {
          search_text: z.string().describe('The exact text to find in the doc'),
          replacement_text: z.string().describe('The text to replace it with'),
          replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
          match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
        },
        async (args) => {
          const info = await resolveActiveGoogleDocInfo();
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
