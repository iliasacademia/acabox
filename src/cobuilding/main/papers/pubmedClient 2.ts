import * as https from 'https';
import log from 'electron-log';
import type { SourcePaper } from './sourceTypes';

const PUBMED_HOST = 'eutils.ncbi.nlm.nih.gov';
const REQUEST_TIMEOUT_MS = 20_000;

interface ESearchResponse {
  esearchresult?: {
    idlist?: string[];
  };
}

interface ESummaryResponse {
  result?: Record<string, ESummaryEntry | string[]>;
}

interface ESummaryEntry {
  uid: string;
  title?: string;
  pubdate?: string;
  source?: string;
  authors?: { name: string }[];
  articleids?: { idtype: string; value: string }[];
  bookname?: string;
}

export async function searchPubmed(searchQuery: string, maxResults: number): Promise<SourcePaper[]> {
  const ids = await pubmedEsearch(searchQuery, maxResults);
  if (ids.length === 0) return [];
  const summaries = await pubmedEsummary(ids);
  return summaries.map(toSourcePaper);
}

async function pubmedEsearch(term: string, maxResults: number): Promise<string[]> {
  const params = new URLSearchParams({
    db: 'pubmed',
    term,
    retmax: String(maxResults),
    retmode: 'json',
    sort: 'pub_date',
  });
  const url = `https://${PUBMED_HOST}/entrez/eutils/esearch.fcgi?${params.toString()}`;
  log.info('[PubMed] esearch', url);
  const body = await httpsGet(url);
  try {
    const parsed = JSON.parse(body) as ESearchResponse;
    return parsed.esearchresult?.idlist ?? [];
  } catch (err) {
    throw new Error(`PubMed esearch returned non-JSON: ${err instanceof Error ? err.message : err}`);
  }
}

async function pubmedEsummary(ids: string[]): Promise<ESummaryEntry[]> {
  const params = new URLSearchParams({
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'json',
  });
  const url = `https://${PUBMED_HOST}/entrez/eutils/esummary.fcgi?${params.toString()}`;
  log.info('[PubMed] esummary', `${ids.length} ids`);
  const body = await httpsGet(url);
  let parsed: ESummaryResponse;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`PubMed esummary returned non-JSON: ${err instanceof Error ? err.message : err}`);
  }
  const result = parsed.result ?? {};
  const entries: ESummaryEntry[] = [];
  for (const id of ids) {
    const entry = result[id];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      entries.push(entry);
    }
  }
  return entries;
}

function toSourcePaper(entry: ESummaryEntry): SourcePaper {
  const doi = entry.articleids?.find((x) => x.idtype === 'doi')?.value ?? null;
  const pmid = entry.uid;
  return {
    source: 'pubmed',
    externalId: `pmid:${pmid}`,
    doi,
    title: cleanText(entry.title ?? ''),
    abstract: '', // esummary doesn't include abstracts; would require a 2nd efetch round trip.
    authors: (entry.authors ?? []).map((a) => a.name).filter(Boolean),
    venue: entry.source ?? entry.bookname ?? 'PubMed',
    publishedAt: parsePubmedDate(entry.pubdate ?? ''),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    pdfUrl: null,
  };
}

// PubMed dates come in many shapes ("2024", "2024 Mar", "2024 Mar 14"). Normalize
// to ISO so cross-source sorting works.
function parsePubmedDate(s: string): string {
  if (!s) return '';
  const trimmed = s.trim();
  // YYYY MMM DD
  const m = trimmed.match(/^(\d{4})\s+([A-Za-z]+)(?:\s+(\d{1,2}))?/);
  if (m) {
    const [, year, monthName, day] = m;
    const month = MONTH_INDEX[monthName.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const d = new Date(Date.UTC(Number(year), month, day ? Number(day) : 1));
      return d.toISOString();
    }
  }
  // YYYY-MM-DD or YYYY/MM/DD
  const isoLike = trimmed.replace(/\//g, '-');
  const ts = Date.parse(isoLike);
  if (!Number.isNaN(ts)) return new Date(ts).toISOString();
  // fallback: just year
  const yearOnly = trimmed.match(/^(\d{4})/);
  if (yearOnly) return new Date(Date.UTC(Number(yearOnly[1]), 0, 1)).toISOString();
  return '';
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

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
          reject(new Error(`PubMed HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('PubMed request timed out')));
    req.on('error', reject);
  });
}
