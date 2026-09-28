/**
 * Turns a chat-search hit's raw prose row into a short, readable line for the
 * chat list (docs/design/chat-search.md, Appendix "Snippet"). Pure, no
 * imports, so it can be exercised directly and reused by the search query in
 * `main/db/chatSearch.ts`.
 */

/** Characters of context kept before a match that is not near its line start. */
const SNIPPET_LEAD_CHARS = 40;

/** `# `…`###### `, `> `, `-`/`*`/`+ `, or an ordinal list marker like `1. `. */
const BLOCK_MARKER_RE = /^(#{1,6}|>|[-*+]|\d+\.) /;

/**
 * Step 4 of the appendix: strip markdown noise so a snippet reads as prose.
 * `atLineStart` gates the block-marker strip — a window that begins mid-line
 * (left-clipped with a leading "…") never had one to strip.
 */
function cleanSnippetText(raw: string, atLineStart: boolean): string {
  let text = raw;
  // [text](url) -> text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Emphasis/code markers carry no meaning in a one-line snippet.
  text = text.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '');
  if (atLineStart) {
    text = text.replace(BLOCK_MARKER_RE, '');
  }
  // Table row -> inline, human-readable list.
  text = text.replace(/\s*\|\s*/g, ' · ');
  text = text.replace(/^(?:\s*· )+/, '').replace(/(?:\s*· )+$/, '');
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

/**
 * Extract the line around a query match (or, absent a match, the chat's first
 * non-empty line) from a prose row, cleaned of markdown noise, for display in
 * chat-search results.
 */
export function proseSnippet(body: string, query: string, maxChars = 160): string {
  const lower = body.toLowerCase();
  const i = query ? lower.indexOf(query.toLowerCase()) : -1;

  if (i === -1) {
    const rawLines = body.split('\n');
    const firstLine = rawLines.find((l) => l.trim().length > 0) ?? rawLines[0] ?? '';
    const clipped = firstLine.length > maxChars;
    const window = clipped ? firstLine.slice(0, maxChars) + '…' : firstLine;
    return cleanSnippetText(window, true);
  }

  const nlBefore = body.lastIndexOf('\n', i);
  const lineStart = nlBefore === -1 ? 0 : nlBefore + 1;
  const nlAfter = body.indexOf('\n', i);
  const lineEnd = nlAfter === -1 ? body.length : nlAfter;
  const line = body.slice(lineStart, lineEnd);

  // Window chosen on the RAW line; cleaning happens after (step 3). It opens a
  // short lead before the match rather than centring on it: the list renders
  // a hit on ONE line and ellipsizes it at roughly 90-100 characters, so a
  // match further right than that was cut off by the row even though the
  // snippet contained it (seen in the live list, 2026-09-28).
  const matchStart = i - lineStart;
  let windowStart = matchStart > SNIPPET_LEAD_CHARS ? matchStart - SNIPPET_LEAD_CHARS : 0;
  if (windowStart > 0) {
    // Don't open mid-word when a word break is close by.
    const space = line.indexOf(' ', windowStart);
    if (space !== -1 && space < matchStart && space - windowStart <= 15) windowStart = space + 1;
  }
  const windowEnd = Math.min(line.length, windowStart + maxChars);
  const clippedLeft = windowStart > 0;
  const clippedRight = windowEnd < line.length;

  const raw = line.slice(windowStart, windowEnd);
  const cleaned = cleanSnippetText(raw, !clippedLeft);
  return (clippedLeft ? '…' : '') + cleaned + (clippedRight ? '…' : '');
}
