import * as https from 'https';
import log from 'electron-log';

export interface ArxivPaper {
  id: string;
  arxivId: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  updated: string;
  url: string;
  pdfUrl: string;
  primaryCategory: string;
}

export interface ArxivQueryOptions {
  searchQuery: string;
  maxResults?: number;
  start?: number;
  sortBy?: 'relevance' | 'lastUpdatedDate' | 'submittedDate';
  sortOrder?: 'ascending' | 'descending';
}

const ARXIV_HOST = 'export.arxiv.org';
const REQUEST_TIMEOUT_MS = 45_000;
const RETRY_ATTEMPTS = 1;

export async function searchArxiv(opts: ArxivQueryOptions): Promise<ArxivPaper[]> {
  const params = new URLSearchParams({
    search_query: opts.searchQuery,
    start: String(opts.start ?? 0),
    max_results: String(opts.maxResults ?? 10),
    sortBy: opts.sortBy ?? 'submittedDate',
    sortOrder: opts.sortOrder ?? 'descending',
  });

  const url = `https://${ARXIV_HOST}/api/query?${params.toString()}`;
  log.info('[arXiv] GET', url);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const start = Date.now();
      const xml = await httpsGet(url);
      log.info(`[arXiv] response ${xml.length} bytes in ${Date.now() - start}ms`);
      return parseArxivAtom(xml);
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < RETRY_ATTEMPTS) {
        log.warn(`[arXiv] attempt ${attempt + 1} failed (${message}), retrying`);
      } else {
        log.error(`[arXiv] failed after ${attempt + 1} attempts: ${message}`);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'academia-electron/paper-monitor' } },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`arXiv HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('arXiv request timed out'));
    });
    req.on('error', reject);
  });
}

// arXiv returns an Atom 1.0 feed. We only need a handful of fields, so a
// targeted parser is simpler than pulling in a full XML library.
function parseArxivAtom(xml: string): ArxivPaper[] {
  const entries = extractAll(xml, 'entry');
  return entries.map(parseEntry).filter((p): p is ArxivPaper => p !== null);
}

function parseEntry(entry: string): ArxivPaper | null {
  const id = extractFirst(entry, 'id');
  const title = extractFirst(entry, 'title');
  if (!id || !title) return null;

  const summary = extractFirst(entry, 'summary') ?? '';
  const published = extractFirst(entry, 'published') ?? '';
  const updated = extractFirst(entry, 'updated') ?? '';

  const authors = extractAll(entry, 'author')
    .map((a) => extractFirst(a, 'name'))
    .filter((n): n is string => Boolean(n));

  const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
  const primaryCategory = extractAttribute(entry, 'arxiv:primary_category', 'term') ?? '';

  return {
    id,
    arxivId,
    title: collapseWhitespace(decodeXml(title)),
    summary: collapseWhitespace(decodeXml(summary)),
    authors,
    published,
    updated,
    url: id,
    pdfUrl,
    primaryCategory,
  };
}

function extractAll(source: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

function extractFirst(source: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(source);
  return m ? m[1].trim() : null;
}

function extractAttribute(source: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`);
  const m = re.exec(source);
  return m ? m[1] : null;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
