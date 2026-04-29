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
  abstract?: string;
  reasoning?: string;
  source?: string;
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
  claims: SlimClaim[];
  configuration?: CiteRightConfiguration;
}

function truncate(text: string | undefined, max: number = MAX_TEXT_LEN): string | undefined {
  if (text === undefined || text === null) return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function slimPublication(pub: any): SlimPublication {
  if (pub === null || typeof pub !== 'object') return {};
  return {
    work_id: pub.work_id ?? pub.id,
    title: pub.title,
    authors: pub.authors,
    publication: pub.publication ?? pub.venue ?? pub['container-title'],
    publication_year: pub.publication_year ?? pub.year,
    doi: pub.doi,
    url: pub.url,
    abstract: truncate(pub.abstract, 500),
  };
}

function slimSuggestedWork(item: any): SlimPublication {
  if (item === null || typeof item !== 'object') return {};
  const work = item.work && typeof item.work === 'object' ? item.work : item;
  return {
    ...slimPublication(work),
    reasoning: typeof item.reasoning === 'string' ? truncate(item.reasoning, 500) : undefined,
    source: typeof item.source === 'string' ? item.source : undefined,
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

export function summarizeReport(response: CitationReportResponse): SlimReport {
  const report = response.report ?? {};
  const claims = Array.isArray(report.claims) ? report.claims : [];
  return {
    report_id: report.report_id ?? report.id,
    done: report.done,
    overview_ready: report.overview_ready,
    classify_text_complete: report.classify_text_complete,
    error: report.error ?? null,
    claims: claims.slice(0, MAX_CLAIMS).map(slimClaim),
    configuration: report.configuration,
  };
}
