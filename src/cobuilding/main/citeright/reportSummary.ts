import type {
  CitationReportResponse,
  CiteRightClaim,
  CiteRightConfiguration,
} from './types';

const MAX_PUBLICATIONS_PER_CLAIM = 5;
const MAX_CLAIMS = 25;
const MAX_TEXT_LEN = 1_000;

export interface SlimPublication {
  work_id?: string;
  title?: string;
  authors?: unknown;
  publication?: string;
  publication_year?: string | number;
  doi?: string;
  url?: string;
  link_url?: string;
  abstract?: string;
  reasoning?: string;
  source?: string;
  impact_factor?: number;
  relevance_score?: number;
  cited_by_count?: number;
  is_oa?: boolean;
  pdf_url?: string;
}

export interface SlimClaim {
  id: string;
  text: string;
  query?: string;
  top_publications: SlimPublication[];
  search_status?: string;
}

export interface SlimReport {
  report_id?: number | string;
  done?: boolean;
  overview_ready?: boolean;
  classify_text_complete?: boolean;
  error?: string | null;
  public_token?: string;
  claims: SlimClaim[];
  configuration?: CiteRightConfiguration;
}

function truncate(text: string | undefined, max: number = MAX_TEXT_LEN): string | undefined {
  if (text === undefined || text === null) return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function slimPublication(pub: any): SlimPublication {
  if (pub === null || typeof pub !== 'object') return {};
  const doi = typeof pub.doi === 'string' && pub.doi.length > 0 ? pub.doi : undefined;
  return {
    work_id: pub.work_id ?? pub.id,
    title: pub.title,
    authors: pub.authors,
    publication: pub.publication ?? pub.venue ?? pub['container-title'],
    publication_year: pub.publication_year ?? pub.year,
    doi,
    url: pub.url,
    link_url: doi ? `https://doi.org/${doi}` : undefined,
    abstract: truncate(pub.abstract, 500),
    cited_by_count: typeof pub.cited_by_count === 'number' ? pub.cited_by_count : undefined,
    is_oa: typeof pub.is_oa === 'boolean' ? pub.is_oa : undefined,
    pdf_url: typeof pub.pdf_url === 'string' ? pub.pdf_url : undefined,
  };
}

function slimSuggestedWork(item: any): SlimPublication {
  if (item === null || typeof item !== 'object') return {};
  const work = item.work && typeof item.work === 'object' ? item.work : item;
  return {
    ...slimPublication(work),
    reasoning: typeof item.reasoning === 'string' ? truncate(item.reasoning, 500) : undefined,
    source: typeof item.source === 'string' ? item.source : undefined,
    impact_factor: typeof item.impact_factor === 'number' ? item.impact_factor : undefined,
    relevance_score: typeof item.relevance_score === 'number' ? item.relevance_score : undefined,
  };
}

function slimClaim(claim: CiteRightClaim): SlimClaim {
  const search = (claim as any).search;
  const suggested = search && Array.isArray(search.suggested_works) ? search.suggested_works : [];
  return {
    id: claim.id,
    text: truncate(claim.text) ?? '',
    query: typeof claim.query === 'string' ? truncate(claim.query, 500) : undefined,
    top_publications: suggested.slice(0, MAX_PUBLICATIONS_PER_CLAIM).map(slimSuggestedWork),
    search_status: search && typeof search === 'object' ? search.status : undefined,
  };
}

/**
 * Process-level cache mapping normalized DOI → SlimPublication. Populated as the agent
 * pulls citation reports through the MCP tools so the renderer (which only sees rendered
 * markdown) can recover the structured fields — is_oa, pdf_url, title, authors, year — when
 * the user clicks a per-reference action like "Add to Zotero".
 */
const publicationByDoi = new Map<string, SlimPublication>();

function normalizeDoi(doi: string): string {
  return doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/[.,;:]+$/, '').toLowerCase();
}

export function getPublicationByDoi(doi: string): SlimPublication | null {
  return publicationByDoi.get(normalizeDoi(doi)) ?? null;
}

function indexPublication(pub: SlimPublication): void {
  if (typeof pub.doi === 'string' && pub.doi.length > 0) {
    publicationByDoi.set(normalizeDoi(pub.doi), pub);
  }
}

export function summarizeReport(response: CitationReportResponse): SlimReport {
  const report = response.report ?? {};
  const claims = Array.isArray(report.claims) ? report.claims : [];
  const slimClaims = claims.slice(0, MAX_CLAIMS).map(slimClaim);
  for (const c of slimClaims) {
    for (const p of c.top_publications) indexPublication(p);
  }
  return {
    report_id: report.report_id ?? report.id,
    done: report.done,
    overview_ready: report.overview_ready,
    classify_text_complete: report.classify_text_complete,
    error: report.error ?? null,
    public_token: typeof report.public_token === 'string' ? report.public_token : undefined,
    claims: slimClaims,
    configuration: report.configuration,
  };
}
