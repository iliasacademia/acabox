import log from 'electron-log';
import { searchArxivAsSource } from './arxivClient';
import { searchPubmed } from './pubmedClient';
import { searchOpenAlex } from './openAlexClient';
import { searchBioRxiv } from './bioRxivClient';
import type { PaperSource, SourcePaper } from './sourceTypes';

export interface PaperRecord {
  id: string;
  source: PaperSource;
  externalId: string;
  doi: string | null;
  title: string;
  abstract: string;
  authors: string[];
  authorsLine: string;
  venue: string;
  publishedAt: string;
  url: string;
  pdfUrl: string | null;
  matchedTopic: string;
  /** Sources that surfaced this paper (deduped union). Useful UX hint. */
  sources: PaperSource[];
}

export interface FetchPapersInput {
  topics: string[];
  /** Per-source-per-topic cap. Defaults to 5. */
  maxPerTopic?: number;
  /** Total cap after dedupe. Defaults to 20. */
  maxTotal?: number;
  /** Restrict the source set; defaults to all. */
  sources?: PaperSource[];
}

export interface FetchPapersResult {
  papers: PaperRecord[];
  fetchedAt: string;
  errors: { source: PaperSource; topic: string; message: string }[];
}

type SourceClient = (query: string, max: number) => Promise<SourcePaper[]>;

const SOURCE_CLIENTS: Record<PaperSource, { search: SourceClient; buildQuery: (topic: string) => string }> = {
  arxiv: {
    // arXiv's quoted phrases are ~3x slower; rely on token-AND instead.
    search: searchArxivAsSource,
    buildQuery: (t) => `all:${t.trim()}`,
  },
  pubmed: {
    search: searchPubmed,
    buildQuery: (t) => t.trim(),
  },
  openalex: {
    search: searchOpenAlex,
    buildQuery: (t) => t.trim(),
  },
  biorxiv: {
    // bioRxiv has no search endpoint — the client filters a date-range fetch.
    search: searchBioRxiv,
    buildQuery: (t) => t.trim(),
  },
};

const DEFAULT_SOURCES: PaperSource[] = ['arxiv', 'pubmed', 'openalex', 'biorxiv'];

export async function fetchPapers(input: FetchPapersInput): Promise<FetchPapersResult> {
  const topics = (input.topics ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (topics.length === 0) {
    return { papers: [], fetchedAt: new Date().toISOString(), errors: [] };
  }

  const sources = (input.sources && input.sources.length > 0 ? input.sources : DEFAULT_SOURCES).filter(
    (s) => s in SOURCE_CLIENTS,
  );
  const maxPerTopic = clamp(input.maxPerTopic ?? 5, 1, 50);
  const maxTotal = clamp(input.maxTotal ?? 20, 1, 200);

  const errors: FetchPapersResult['errors'] = [];

  // Cross product: every (topic × source) is one parallel call. Promise.allSettled
  // so one slow/dead source doesn't sink the whole digest.
  const tasks = topics.flatMap((topic) =>
    sources.map(async (source) => {
      const client = SOURCE_CLIENTS[source];
      try {
        const results = await client.search(client.buildQuery(topic), maxPerTopic);
        return { source, topic, results };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[Papers] ${source}/${topic} failed: ${message}`);
        errors.push({ source, topic, message });
        return { source, topic, results: [] as SourcePaper[] };
      }
    }),
  );

  const settled = await Promise.all(tasks);

  // Merge with dedupe. Key preference: DOI > normalized title.
  const byKey = new Map<string, { record: PaperRecord; topicOrder: number }>();
  for (let i = 0; i < settled.length; i++) {
    const { topic, results } = settled[i];
    for (const sp of results) {
      const key = dedupeKey(sp);
      const existing = byKey.get(key);
      if (existing) {
        // Already have it from another source; just record the additional source
        // and prefer the longer abstract (PubMed esummary returns no abstract,
        // arXiv & OpenAlex usually do).
        if (!existing.record.sources.includes(sp.source)) existing.record.sources.push(sp.source);
        if (sp.abstract.length > existing.record.abstract.length) {
          existing.record.abstract = sp.abstract;
        }
        if (!existing.record.doi && sp.doi) existing.record.doi = sp.doi;
        if (!existing.record.pdfUrl && sp.pdfUrl) existing.record.pdfUrl = sp.pdfUrl;
        continue;
      }
      byKey.set(key, {
        record: toPaperRecord(sp, topic),
        topicOrder: i,
      });
    }
  }

  const merged = Array.from(byKey.values()).map((x) => x.record);
  merged.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  return {
    papers: merged.slice(0, maxTotal),
    fetchedAt: new Date().toISOString(),
    errors,
  };
}

function dedupeKey(p: SourcePaper): string {
  if (p.doi) return `doi:${p.doi.toLowerCase()}`;
  return `title:${normalizeTitle(p.title)}`;
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toPaperRecord(p: SourcePaper, matchedTopic: string): PaperRecord {
  return {
    id: p.externalId,
    source: p.source,
    externalId: p.externalId,
    doi: p.doi,
    title: p.title,
    abstract: p.abstract,
    authors: p.authors,
    authorsLine: formatAuthorsLine(p.authors),
    venue: p.venue,
    publishedAt: p.publishedAt,
    url: p.url,
    pdfUrl: p.pdfUrl,
    matchedTopic,
    sources: [p.source],
  };
}

function formatAuthorsLine(authors: string[]): string {
  if (authors.length === 0) return '';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')}, et al.`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}
