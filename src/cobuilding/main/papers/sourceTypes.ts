export type PaperSource = 'arxiv' | 'pubmed' | 'openalex' | 'biorxiv';

/** Normalized result from any source — converted into a PaperRecord by the service. */
export interface SourcePaper {
  source: PaperSource;
  externalId: string;
  /** DOI is the strongest dedupe key when available. */
  doi: string | null;
  title: string;
  abstract: string;
  authors: string[];
  venue: string;
  publishedAt: string;
  url: string;
  pdfUrl: string | null;
}
