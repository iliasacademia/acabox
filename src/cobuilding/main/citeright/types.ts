export const CITERIGHT_CITATION_FORMATS = [
  'MLA',
  'APA',
  'Chicago',
  'Vancouver',
  'Harvard',
  'IEEE',
  'ACS',
] as const;

export type CiteRightCitationFormat = typeof CITERIGHT_CITATION_FORMATS[number];

export interface CiteRightAuthor {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  full_name?: string;
}

export interface CiteRightWorkInput {
  work_id?: string;
  title: string;
  authors?: Array<CiteRightAuthor | string>;
  publication?: string;
  publication_year?: string | number;
  publisher?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  claim_id?: string;
  claim_text?: string;
}

export interface CiteRightFormattedCitation {
  id?: string;
  claim_id?: string;
  citations: Record<string, string>;
}

export interface FormatCitationsResponse {
  citations: CiteRightFormattedCitation[];
}

export interface CiteRightClaim {
  id: string;
  text: string;
  query?: string;
  ranked_publications?: unknown[];
  [key: string]: unknown;
}

export type CiteRightSearchStrategy = 'auto_all' | 'auto_first' | 'auto_top_n' | 'manual';

export type CiteRightSearchMethod =
  | 'citation_search_agent'
  | 'refutation_finder'
  | 'web_search'
  | 'web_search_agentful'
  | 'academia_publication_search'
  | 'mock';

export interface CiteRightConfiguration {
  cost_limit?: number;
  search_strategy?: CiteRightSearchStrategy;
  auto_top_n_count?: number;
  citation_search_method?: CiteRightSearchMethod;
  refutation_finder_as_fallback?: boolean;
  cohere_rerank?: boolean;
  extract_references?: boolean;
  extract_in_text_citations?: boolean;
  highlight_existing_citations?: boolean;
  refutation_finder_streaming?: boolean;
  chunk_size?: number;
  overlap_percentage?: number;
  relevance_score_threshold?: number;
  mock_classify_text?: boolean;
  mock_extract_references?: boolean;
  datadog_tracing_enabled?: boolean;
  prompt_tracing_enabled?: boolean;
  web_search_model?: string;
  pre_generation_web_search_model?: string;
  academia_publication_search_enabled?: boolean;
  [key: string]: unknown;
}

export interface CiteRightReport {
  id?: number | string;
  report_id?: number | string;
  done?: boolean;
  overview_ready?: boolean;
  classify_text_complete?: boolean;
  message_to_user?: string;
  error?: string | null;
  document_text?: string;
  claims?: CiteRightClaim[];
  configuration?: CiteRightConfiguration;
  public_token?: string;
  [key: string]: unknown;
}

export interface CitationReportResponse {
  report: CiteRightReport;
}

export interface ListReportsResponse {
  reports: Array<{
    id: number | string;
    title: string;
    file_type: string;
    status: string;
    updated_at: string;
    has_redis_data: boolean;
  }>;
  pagination: {
    current_page: number;
    per_page: number;
    total_count: number;
    total_pages: number;
    has_more: boolean;
  };
}
