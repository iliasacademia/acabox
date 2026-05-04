import { defaultLogger as logger } from '../../../utils/logger';
import { browserExtensionServer, type ActiveGoogleDocResult } from '../../../server/browserExtensionServer';
import { createGoogleDocsMcpServer } from '../mcpServers/googleDocsMcpServer';
import { isConnected as isGoogleDocsApiConnected, findAndReplace as findAndReplaceViaApi } from '../googleDocsService';
import type { HostApp, ApplyEditParams, ApplyEditResult } from './types';

const CHROME_BUNDLE_ID = 'com.google.Chrome';

const GOOGLE_DOCS_ALLOWED_TOOLS = [
  'mcp__google-docs__get_active_doc',
  'mcp__google-docs__get_text',
  'mcp__google-docs__find_and_replace',
];

const GOOGLE_DOCS_SYSTEM_PROMPT_APPEND = `You can read and propose edits in the user's Google Doc through the google-docs MCP tools.

When the user wants to chat about or edit their active Google Doc:
1. Call mcp__google-docs__get_active_doc to confirm a Google Doc is in front of the user and learn its title.
2. Call mcp__google-docs__get_text to read the doc body. By default this returns the full document; pass selection_only=true when the user has highlighted a passage and wants you to act on just that.
3. To suggest an edit, call mcp__google-docs__find_and_replace once per edit. The Academia overlay panel (where you and the user are chatting) renders a styled suggestion card with an Apply button right below your tool call. The card lives in the overlay, NOT inside Google Docs. Tell the user "I've proposed N edit(s) — click Apply on the card above" — do NOT describe the edits in your text.

Important caveats:
- Body text is sourced from the official Google Docs API when the user has connected their Google account (Settings → Connect Google), and from Google Docs' plain-text export endpoint via the browser extension when they haven't. The API path handles multi-tab Google Docs, headers, and download-restricted docs that the export endpoint can't read.
- Apply on find_and_replace works through the Docs API once the user has connected Google. When not connected, Apply is disabled and the user has to copy the suggested replacement into the doc manually.
- Comments are NOT included in the body read. Selection is always live and reflects the user's current highlight.
- This integration only supports Google Chrome with the Academia browser extension connected. If get_active_doc returns no document, tell the user to switch to a Google Doc tab in Chrome.`;

const GOOGLE_DOCS_URL_PATTERN = /^https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)(?:\/|$|\?)/i;

/**
 * Convert a Google Docs URL into the synthetic `gdocs://<docId>` document path
 * the rest of the host-app machinery uses to scope sessions and route MCP
 * tools. Accepts edit/preview/copy variants, returns null for non-Docs URLs
 * (slides/sheets/forms have different document-type roots).
 */
export function googleDocsUrlToDocumentPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = GOOGLE_DOCS_URL_PATTERN.exec(url);
  if (!m) return null;
  return `gdocs://${m[1]}`;
}

/** Inverse of {@link googleDocsUrlToDocumentPath}: pull the doc id back out. */
export function documentPathToGoogleDocId(documentPath: string | null | undefined): string | null {
  if (!documentPath) return null;
  const m = /^gdocs:\/\/([a-zA-Z0-9_-]+)$/.exec(documentPath);
  return m ? m[1] : null;
}

async function googleDocsApplyEdit(params: ApplyEditParams): Promise<ApplyEditResult> {
  // Phase C2: when the user has connected Google via OAuth we apply edits
  // through the Docs API's `documents.batchUpdate` replaceAllText path. When
  // they haven't, edits remain proposal-only (Phase A behavior).
  if (!isGoogleDocsApiConnected()) {
    return {
      success: false,
      error: 'Google Docs edits cannot be applied yet — connect your Google account in Settings → Google Docs Integration to enable Apply. Until then, copy the proposed replacement into the doc manually.',
      replacementsCount: 0,
    };
  }
  const docId = documentPathToGoogleDocId(params.document_path ?? null);
  if (!docId) {
    return {
      success: false,
      error: 'Google Docs apply-edit requires document_path of the form gdocs://<docId>',
      replacementsCount: 0,
    };
  }
  const result = await findAndReplaceViaApi(
    docId,
    params.search_text,
    params.replacement_text,
    params.match_case ?? true,
  );
  if (!result.success) {
    return { success: false, error: result.error ?? 'Docs API call failed', replacementsCount: 0 };
  }
  const count = result.data?.replacementsCount ?? 0;
  logger.info(`[GoogleDocsHostApp] Applied ${count} replacement(s) to doc ${docId} via Docs API`);
  return { success: true, replacementsCount: count };
}

export const googleDocsHostApp: HostApp = {
  id: 'google-docs',
  // Phase A binds to Chrome only — the only browser the Academia extension
  // ships in today. Multi-browser support is a follow-up; the protocol on the
  // wire is browser-agnostic.
  bundleId: CHROME_BUNDLE_ID,
  displayName: 'Google Docs',
  // Synthetic `gdocs://` paths only — no real file extensions.
  fileExtensions: [],

  windowMonitorArgs() {
    // Track Chrome windows so the overlay knows when a browser window is
    // focused. Selection text comes from the extension WebSocket, not AX, so
    // we don't pass --track-text-selection.
    return ['--bundle-id', CHROME_BUNDLE_ID];
  },

  /**
   * The native window-monitor doesn't see Chrome's URL — only the bundle id
   * and window title. Synchronous resolution returns null; the active doc id
   * is fetched async by `resolveActiveGoogleDocPath()` (called from
   * windowMonitorService) and surfaced via its own cache.
   */
  resolveDocumentPath() {
    return null;
  },

  mcpServerKey: 'google-docs',
  createMcpServer() {
    return createGoogleDocsMcpServer();
  },

  allowedTools: GOOGLE_DOCS_ALLOWED_TOOLS,
  systemPromptAppend: GOOGLE_DOCS_SYSTEM_PROMPT_APPEND,
  // No `sessionDocumentPathLikePattern` — Google Docs sessions are strictly
  // scoped to the specific doc (`gdocs://<docId>`). When the extension hasn't
  // resolved a doc id yet, the overlay shows an empty list rather than a
  // host-wide fallback. Apple Notes opts in to that fallback because notes
  // browsing is folder-rooted; Docs is always file-rooted.

  messagePrefix({ documentPath, selectedText }) {
    let prefix = '';
    if (documentPath) prefix += `Active Google Doc: ${documentPath}\n`;
    if (selectedText) {
      prefix += `The user has selected the following text in the doc. Act ONLY on this selected text, not the entire doc.\n"""\n${selectedText}\n"""\n`;
    }
    return prefix;
  },

  applyEdit: googleDocsApplyEdit,
};

export interface ActiveGoogleDocInfo {
  /** Synthetic `gdocs://<docId>` path used everywhere internally. */
  documentPath: string;
  /** Display title from the Chrome tab (without the trailing "- Google Docs" suffix). */
  title: string | null;
  /** Selected text in the doc, or null when nothing is selected. */
  selectedText: string | null;
  /** Original Google Docs URL — useful for debugging / opening in a fresh tab. */
  url: string | null;
}

/**
 * Ask the browser extension for the active Google Doc and surface its full
 * context (path + title + current selection). Returns null when no Google Doc
 * is focused or the extension is disconnected.
 *
 * windowMonitorService calls this on every poll-driven refresh and caches the
 * result so the overlay can display title and selection without extra IPC on
 * every render.
 */
export async function resolveActiveGoogleDocInfo(): Promise<ActiveGoogleDocInfo | null> {
  try {
    const result: ActiveGoogleDocResult | null = await browserExtensionServer.getActiveGoogleDoc(1500);
    if (!result) return null;
    const documentPath = result.documentPath ?? googleDocsUrlToDocumentPath(result.url);
    if (!documentPath) return null;
    return {
      documentPath,
      title: result.title ?? null,
      selectedText: result.selectedText ?? null,
      url: result.url ?? null,
    };
  } catch (err) {
    logger.warn('[GoogleDocsHostApp] resolveActiveGoogleDocInfo failed:', (err as Error).message);
    return null;
  }
}

/** Path-only convenience kept for back-compat with code that doesn't need title/selection. */
export async function resolveActiveGoogleDocPath(): Promise<string | null> {
  const info = await resolveActiveGoogleDocInfo();
  return info?.documentPath ?? null;
}
