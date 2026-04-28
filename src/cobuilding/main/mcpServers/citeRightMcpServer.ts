import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkLogin } from '../../../apiClient';
import {
  addClaimToReport,
  createCitationReportFromText,
  findReferencesForText,
  formatCitations,
  getCitationReport,
  listCitationReports,
  searchCitationsForClaim,
} from '../citeright/citeRightClient';
import { CITERIGHT_CITATION_FORMATS } from '../citeright/types';
import { summarizeReport } from '../citeright/reportSummary';

const NOT_LOGGED_IN_MESSAGE =
  'CiteRight requires a logged-in academia.edu account. Ask the user to sign in and try again.';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

async function runWhenLoggedIn(operation: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    const isLoggedIn = await checkLogin();
    if (!isLoggedIn) return fail(NOT_LOGGED_IN_MESSAGE);
    return await operation();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`CiteRight call failed: ${message}`);
  }
}

const authorSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  middle_name: z.string().optional(),
  full_name: z.string().optional(),
});

const workSchema = z.object({
  work_id: z.string().optional(),
  title: z.string(),
  authors: z.array(z.union([authorSchema, z.string()])).optional(),
  publication: z.string().optional(),
  publication_year: z.union([z.string(), z.number()]).optional(),
  publisher: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().optional(),
  abstract: z.string().optional(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  pages: z.string().optional(),
  claim_id: z.string().optional(),
  claim_text: z.string().optional(),
});

export function createCiteRightMcpServer() {
  return createSdkMcpServer({
    name: 'citeright',
    tools: [
      tool(
        'find_references',
        'Find verified references for a passage or claim. Submits the text to CiteRight, polls until the backend ' +
        'reports done:true, and returns the report with claims + top_publications populated. Use this as the default ' +
        'tool when the user asks for references — it handles polling internally so you do not need to call ' +
        'create_citation_report + get_citation_report yourself. Polling can take several minutes for long passages.',
        {
          document_text: z.string().describe('The passage, claim, or excerpt to find references for.'),
          timeout_seconds: z.number().int().min(10).max(900).optional().default(600)
            .describe('Maximum seconds to wait for the backend to finish ranking (default 600 / 10 min).'),
          poll_interval_seconds: z.number().int().min(1).max(15).optional().default(3)
            .describe('Seconds between polls (default 3).'),
        },
        async (args) => runWhenLoggedIn(async () => {
          const response = await findReferencesForText(args.document_text, {
            timeoutMs: args.timeout_seconds * 1000,
            pollIntervalMs: args.poll_interval_seconds * 1000,
          });
          const done = response.report?.done === true;
          const note = done
            ? ''
            : ' NOTE: backend did not finish within the timeout — partial state returned. ' +
              'You may call get_citation_report with the report id to check again later.';
          return ok(JSON.stringify(summarizeReport(response)) + note);
        }),
      ),

      tool(
        'create_citation_report',
        'Submit document text to CiteRight to start a citation analysis. Returns a report with an id. ' +
        'The backend extracts claims and ranks candidate publications asynchronously — poll get_citation_report ' +
        'until claims contain ranked_publications.',
        {
          document_text: z.string().describe('The full document or excerpt to analyze for citations.'),
        },
        async (args) => runWhenLoggedIn(async () => {
          const response = await createCitationReportFromText(args.document_text);
          return ok(JSON.stringify(summarizeReport(response)));
        }),
      ),

      tool(
        'get_citation_report',
        'Fetch the current state of a CiteRight citation report by id, including claims and any ranked publications produced so far.',
        {
          report_id: z.union([z.string(), z.number()]).describe('Citation report id returned by create_citation_report.'),
        },
        async (args) => runWhenLoggedIn(async () => {
          const response = await getCitationReport(args.report_id);
          return ok(JSON.stringify(summarizeReport(response)));
        }),
      ),

      tool(
        'add_claim_to_report',
        'Add a manual claim/query to an existing citation report. Returns the updated report with the new claim id, ' +
        'which can then be passed to search_citations_for_claim.',
        {
          report_id: z.union([z.string(), z.number()]),
          text: z.string().describe('The claim or query text to search citations for.'),
        },
        async (args) => runWhenLoggedIn(async () => {
          const response = await addClaimToReport(args.report_id, args.text);
          return ok(JSON.stringify(summarizeReport(response)));
        }),
      ),

      tool(
        'search_citations_for_claim',
        'Run citation search for a specific claim within a report. Returns the updated report with ranked_publications populated for that claim.',
        {
          report_id: z.union([z.string(), z.number()]),
          claim_id: z.string(),
        },
        async (args) => runWhenLoggedIn(async () => {
          const response = await searchCitationsForClaim(args.report_id, args.claim_id);
          return ok(JSON.stringify(summarizeReport(response)));
        }),
      ),

      tool(
        'format_citations',
        `Format an array of work metadata into citation strings. Stateless — does not require a report. ` +
        `Returns formatted strings in: ${CITERIGHT_CITATION_FORMATS.join(', ')}. Up to 50 works per call.`,
        {
          works: z.array(workSchema).min(1).max(50)
            .describe('Works to format. Each must have a title; other fields (authors, doi, year, etc.) improve quality.'),
        },
        async (args) => runWhenLoggedIn(async () => {
          const response = await formatCitations(args.works);
          return ok(JSON.stringify(response));
        }),
      ),

      tool(
        'list_citation_reports',
        'List the current user\'s recent citation reports (paginated, newest first). Use to resume work on a prior report.',
        {
          page: z.number().int().min(1).optional().default(1),
          per_page: z.number().int().min(1).max(50).optional().default(10),
        },
        async (args) => runWhenLoggedIn(async () => {
          const response = await listCitationReports(args.page, args.per_page);
          return ok(JSON.stringify(response));
        }),
      ),
    ],
  });
}
