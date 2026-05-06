import { searchArxiv, type ArxivPaper } from './arxivClient';

export interface PaperRecord {
  id: string;
  source: 'arxiv';
  externalId: string;
  title: string;
  abstract: string;
  authors: string[];
  authorsLine: string;
  venue: string;
  publishedAt: string;
  url: string;
  pdfUrl: string;
  matchedTopic: string;
}

export interface FetchPapersInput {
  /** Free-form list, e.g. ["wound healing", "YAP/TAZ", "mechanotransduction"]. */
  topics: string[];
  /** Per-topic cap. Defaults to 5. */
  maxPerTopic?: number;
  /** Total cap across all topics after dedupe. Defaults to 20. */
  maxTotal?: number;
}

export interface FetchPapersResult {
  papers: PaperRecord[];
  fetchedAt: string;
  errors: { topic: string; message: string }[];
}

export async function fetchPapers(input: FetchPapersInput): Promise<FetchPapersResult> {
  const topics = (input.topics ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (topics.length === 0) {
    return { papers: [], fetchedAt: new Date().toISOString(), errors: [] };
  }

  const maxPerTopic = clamp(input.maxPerTopic ?? 5, 1, 50);
  const maxTotal = clamp(input.maxTotal ?? 20, 1, 200);

  const errors: { topic: string; message: string }[] = [];
  const results = await Promise.all(
    topics.map(async (topic) => {
      try {
        const papers = await searchArxiv({
          searchQuery: buildArxivQuery(topic),
          maxResults: maxPerTopic,
          sortBy: 'submittedDate',
          sortOrder: 'descending',
        });
        return papers.map((p) => toPaperRecord(p, topic));
      } catch (err) {
        errors.push({ topic, message: errMessage(err) });
        return [];
      }
    }),
  );

  // Dedupe by externalId, keep the first match (preserves most-recent topic order).
  const seen = new Set<string>();
  const merged: PaperRecord[] = [];
  for (const list of results) {
    for (const p of list) {
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      merged.push(p);
      if (merged.length >= maxTotal) break;
    }
    if (merged.length >= maxTotal) break;
  }

  // Sort newest-first by publishedAt.
  merged.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  return {
    papers: merged,
    fetchedAt: new Date().toISOString(),
    errors,
  };
}

function toPaperRecord(p: ArxivPaper, matchedTopic: string): PaperRecord {
  return {
    id: `arxiv:${p.arxivId}`,
    source: 'arxiv',
    externalId: p.arxivId,
    title: p.title,
    abstract: p.summary,
    authors: p.authors,
    authorsLine: formatAuthorsLine(p.authors),
    venue: p.primaryCategory ? `arXiv (${p.primaryCategory})` : 'arXiv',
    publishedAt: p.published,
    url: p.url,
    pdfUrl: p.pdfUrl,
    matchedTopic,
  };
}

function formatAuthorsLine(authors: string[]): string {
  if (authors.length === 0) return '';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')}, et al.`;
}

// Build an arXiv query for a topic. We deliberately avoid quoting multi-word
// phrases — arXiv's full-text index handles quoted phrases on `all:` an order
// of magnitude slower than the unquoted form (≈45s vs ≈15s in practice). The
// unquoted form ANDs the tokens together which is still topical enough.
function buildArxivQuery(topic: string): string {
  const trimmed = topic.trim();
  if (!trimmed) return '';
  return `all:${trimmed}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
