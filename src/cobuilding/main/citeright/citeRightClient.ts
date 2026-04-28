import { callBackendApi } from '../../../apiCall';
import type {
  CiteRightWorkInput,
  CitationReportResponse,
  FormatCitationsResponse,
  ListReportsResponse,
} from './types';

export const CITERIGHT_CALLER_SOURCE = 'academia-coscientist';

const BASE = 'v0/citeright';

function withCaller<T extends Record<string, any>>(payload: T): T & { upload_source: string } {
  return { upload_source: CITERIGHT_CALLER_SOURCE, ...payload };
}

export async function createCitationReportFromText(documentText: string): Promise<CitationReportResponse> {
  return callBackendApi<CitationReportResponse>({
    method: 'POST',
    endpoint: `${BASE}/citation_report`,
    data: withCaller({ document_text: documentText }),
  });
}

export async function getCitationReport(reportId: string | number): Promise<CitationReportResponse> {
  return callBackendApi<CitationReportResponse>({
    method: 'GET',
    endpoint: `${BASE}/citation_report?report_id=${encodeURIComponent(String(reportId))}`,
  });
}

export async function addClaimToReport(
  reportId: string | number,
  text: string,
): Promise<CitationReportResponse> {
  return callBackendApi<CitationReportResponse>({
    method: 'POST',
    endpoint: `${BASE}/add_query`,
    data: withCaller({ report_id: reportId, text }),
  });
}

export async function searchCitationsForClaim(
  reportId: string | number,
  claimId: string,
): Promise<CitationReportResponse> {
  return callBackendApi<CitationReportResponse>({
    method: 'POST',
    endpoint: `${BASE}/search`,
    data: withCaller({ report_id: reportId, claim_id: claimId }),
  });
}

export async function formatCitations(works: CiteRightWorkInput[]): Promise<FormatCitationsResponse> {
  return callBackendApi<FormatCitationsResponse>({
    method: 'POST',
    endpoint: `${BASE}/generate_citations`,
    data: withCaller({ works }),
  });
}

export async function listCitationReports(
  page = 1,
  perPage = 10,
): Promise<ListReportsResponse> {
  const params = `page=${page}&per_page=${perPage}`;
  return callBackendApi<ListReportsResponse>({
    method: 'GET',
    endpoint: `${BASE}/list_reports?${params}`,
  });
}

export interface AwaitReportOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function awaitCitationReportReady(
  reportId: string | number,
  options: AwaitReportOptions = {},
): Promise<CitationReportResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let latest: CitationReportResponse = await getCitationReport(reportId);
  while (!latest.report?.done && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    latest = await getCitationReport(reportId);
  }
  return latest;
}

export async function findReferencesForText(
  documentText: string,
  options: AwaitReportOptions = {},
): Promise<CitationReportResponse> {
  const created = await createCitationReportFromText(documentText);
  const reportId = created.report?.report_id ?? created.report?.id;
  if (reportId === undefined) {
    return created;
  }
  return awaitCitationReportReady(reportId, options);
}
