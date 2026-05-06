import * as https from 'https';
import log from 'electron-log';
import type { SourcePaper } from './sourceTypes';

const BIORXIV_HOST = 'api.biorxiv.org';
const REQUEST_TIMEOUT_MS = 20_000;
const LOOKBACK_DAYS = 7;

interface BioRxivResponse {
  collection?: BioRxivPreprint[];
  messages?: { status?: string; count?: number; total?: number }[];
}

interface BioRxivPreprint {
  doi: string;
  title: string;
  authors: string;
  author_corresponding?: string;
  date?: string;
  category?: string;
  abstract?: string;
  server?: string;
}

// bioRxiv has no keyword-search endpoint — only date-range fetch. We pull the
// last week of preprints and filter client-side by token match against title +
// abstract. Topical enough for a weekly digest, and we cap at one page so we
// don't hammer their API.
export async function searchBioRxiv(
  searchQuery: string,
  maxResults: number,
): Promise<SourcePaper[]> {
  const tokens = extractTokens(searchQuery);
  if (tokens.length === 0) return [];

  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const interval = `${formatDate(from)}/${formatDate(to)}`;

  const url = `https://${BIORXIV_HOST}/details/biorxiv/${interval}/0/json`;
  log.info('[bioRxiv] GET', url);

  const body = await httpsGet(url);
  let parsed: BioRxivResponse;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`bioRxiv returned non-JSON: ${err instanceof Error ? err.message : err}`);
  }

  const all = parsed.collection ?? [];
  const matches: SourcePaper[] = [];
  for (const p of all) {
    const haystack = `${p.title ?? ''} ${p.abstract ?? ''}`.toLowerCase();
    if (tokens.every((t) => haystack.includes(t))) {
      matches.push(toSourcePaper(p));
      if (matches.length >= maxResults) break;
    }
  }
  return matches;
}

function toSourcePaper(p: BioRxivPreprint): SourcePaper {
  const doi = p.doi || null;
  return {
    source: 'biorxiv',
    externalId: `biorxiv:${p.doi}`,
    doi,
    title: cleanText(p.title ?? ''),
    abstract: cleanText(p.abstract ?? ''),
    authors: parseAuthors(p.authors ?? ''),
    venue: p.server === 'medrxiv' ? 'medRxiv' : 'bioRxiv',
    publishedAt: p.date ? `${p.date}T00:00:00.000Z` : '',
    url: doi ? `https://doi.org/${doi}` : '',
    pdfUrl: doi ? `https://www.biorxiv.org/content/${doi}.full.pdf` : null,
  };
}

function parseAuthors(s: string): string[] {
  // bioRxiv uses "Last, F.; Last2, G." — split on semicolons, trim each.
  return s
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
}

function extractTokens(query: string): string[] {
  // Strip arXiv-style field prefixes that the orchestrator might pass through.
  const cleaned = query.replace(/\b(?:all|ti|abs|au):/g, ' ').replace(/["()]/g, ' ');
  return cleaned
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'over', 'this', 'that']);

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'academia-electron/paper-monitor', Accept: 'application/json' } },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`bioRxiv HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('bioRxiv request timed out')));
    req.on('error', reject);
  });
}
