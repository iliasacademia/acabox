/**
 * Renders the `/` listing page for `acabox-share` — one row per published
 * artifact, newest first. Pure string templating: no framework, no build
 * step, no external assets (fonts/scripts/stylesheets are all inline), so it
 * can be served straight from `routes.ts` with no extra fetch.
 */

import type { ShareIndex, ShareIndexEntry } from '../../../cobuilding/shared/share';
import { kindPrefix } from '../../../cobuilding/shared/share';

const PAGE_TITLE = 'Shared from Acabox';

/** Escapes the five HTML-significant characters. Used for every interpolated value. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `2026-09-10` from an ISO 8601 timestamp; falls back to the raw string if it doesn't parse. */
function formatPublishedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

function renderRow(entry: ShareIndexEntry): string {
  const href = `/${kindPrefix(entry.kind)}/${entry.id}/`;
  const badgeLabel = entry.kind === 'app' ? 'App' : 'File';
  const description = entry.description
    ? `<div class="description">${escapeHtml(entry.description)}</div>`
    : '';

  return `<div class="row">
      <span class="badge">${escapeHtml(badgeLabel)}</span>
      <div class="info">
        <div class="title"><a href="${escapeHtml(href)}">${escapeHtml(entry.title)}</a></div>
        ${description}
      </div>
      <span class="date">${escapeHtml(formatPublishedDate(entry.publishedAt))}</span>
    </div>`;
}

export function renderListing(index: ShareIndex): string {
  const sorted = [...index.artifacts].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
  const body =
    sorted.length > 0
      ? `<div class="rows">\n${sorted.map(renderRow).join('\n')}\n    </div>`
      : '<p class="empty">Nothing published yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PAGE_TITLE}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 24px;
    background: #faf9f7;
    color: #17171a;
    font-family: "DM Sans", system-ui, sans-serif;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 {
    font-size: 20px;
    font-weight: 600;
    margin: 0 0 24px;
  }
  .rows { border-top: 1px solid #e4e2dd; }
  .row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 16px 0;
    border-bottom: 1px solid #e4e2dd;
  }
  .badge {
    flex-shrink: 0;
    padding: 2px 6px;
    border-radius: 4px;
    background: #eceae5;
    color: #55534d;
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .info { flex: 1; min-width: 0; }
  .title { font-weight: 600; overflow-wrap: anywhere; }
  .title a { color: inherit; text-decoration: none; }
  .title a:hover { text-decoration: underline; }
  .description {
    margin-top: 2px;
    color: #55534d;
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .date {
    flex-shrink: 0;
    color: #86847d;
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 12px;
  }
  .empty { color: #55534d; }
</style>
</head>
<body>
<main>
  <h1>${PAGE_TITLE}</h1>
  ${body}
</main>
</body>
</html>
`;
}
