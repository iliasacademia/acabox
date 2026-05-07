import * as https from 'https';
import log from 'electron-log';
import type { SourcePaper } from './sourceTypes';

const OPENALEX_HOST = 'api.openalex.org';
const REQUEST_TIMEOUT_MS = 20_000;

interface OpenAlexResponse {
  results?: OpenAlexWork[];
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string;
  display_name?: string;
  publication_date?: string;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: {
    source?: { display_name?: string };
    pdf_url?: string | null;
    landing_page_url?: string | null;
  } | null;
  authorships?: { author?: { display_name?: string } }[];
}

export async function searchOpenAlex(searchQuery: string, maxResults: number): Promise<SourcePaper[]> {
  const params = new URLSearchParams({
    search: searchQuery,
    'per-page': String(maxResults),
    sort: 'publication_date:desc',
  });
  const url = `https://${OPENALEX_HOST}/works?${params.toString()}`;
  log.info('[OpenAlex] GET', url);
  const body = await httpsGet(url);
  let parsed: OpenAlexResponse;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`OpenAlex returned non-JSON: ${err instanceof Error ? err.message : err}`);
  }
  return (parsed.results ?? []).map(toSourcePaper);
}

function toSourcePaper(w: OpenAlexWork): SourcePaper {
  const externalId = (w.id ?? '').replace(/^https?:\/\/openalex\.org\//, '') || 'openalex:unknown';
  const doi = (w.doi ?? '').replace(/^https?:\/\/doi\.org\//, '') || null;
  const venue = w.primary_location?.source?.display_name ?? 'OpenAlex';
  const pdfUrl = w.primary_location?.pdf_url ?? null;
  const url = w.primary_location?.landing_page_url ?? (w.id ?? '');
  return {
    source: 'openalex',
    externalId: `openalex:${externalId}`,
    doi,
    title: cleanText(w.title ?? w.display_name ?? ''),
    abstract: reconstructAbstract(w.abstract_inverted_index ?? null),
    authors: (w.authorships ?? [])
      .map((a) => a.author?.display_name ?? '')
      .filter((n): n is string => Boolean(n)),
    venue,
    publishedAt: w.publication_date ? `${w.publication_date}T00:00:00.000Z` : '',
    url,
    pdfUrl,
  };
}

// OpenAlex doesn't ship abstracts as plain text — they ship a word→positions
// inverted index and ask consumers to reconstruct. We rebuild the original
// sentence by sorting words by their first position.
function reconstructAbstract(inverted: Record<string, number[]> | null): string {
  if (!inverted) return '';
  const entries: { pos: number; word: string }[] = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const p of positions) entries.push({ pos: p, word });
  }
  entries.sort((a, b) => a.pos - b.pos);
  return entries.map((e) => e.word).join(' ');
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
          reject(new Error(`OpenAlex HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('OpenAlex request timed out')));
    req.on('error', reject);
  });
}
