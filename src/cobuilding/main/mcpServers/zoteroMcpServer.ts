import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  addDoiToZotero,
  getZoteroItem,
  getZoteroLocalStatus,
  searchZoteroLibrary,
} from '../../../zoteroLocalClient';

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

export function createZoteroMcpServer() {
  return createSdkMcpServer({
    name: 'zotero',
    tools: [
      tool(
        'status',
        'Check whether the local Zotero desktop client is running and reachable. Returns one of: ' +
        '"running" (connector responds), "not-running" (Zotero installed but not launched), or ' +
        '"not-installed". Call this first when the user asks for references from their library so ' +
        'you can give a useful error if Zotero is not available.',
        {},
        async () => {
          try {
            const status = await getZoteroLocalStatus();
            return ok(JSON.stringify({ status }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return fail(`Zotero status check failed: ${message}`);
          }
        },
      ),

      tool(
        'search_library',
        'Search the user\'s local Zotero library for references matching a query. Talks to Zotero\'s ' +
        'local web API on 127.0.0.1:23119; requires Zotero 7+ with extensions.zotero.httpServer.enabled. ' +
        'Use this alongside CiteRight when the user asks for references — Zotero surfaces what they\'ve ' +
        'already collected, while CiteRight ranks the broader literature. Returns slim item metadata ' +
        '(key, title, creators, date, DOI, publicationTitle, abstractNote, tags). When an item has a DOI, ' +
        'render it in your response — the desktop UI auto-links DOIs and shows an "Open in Zotero" affordance.',
        {
          query: z.string().min(1).max(500)
            .describe('Search text. With qmode=titleCreatorYear (default), matches title/creators/year. ' +
              'With qmode=everything, matches all indexed fields (use this to look up a DOI).'),
          limit: z.number().int().min(1).max(50).optional().default(10)
            .describe('Maximum number of items to return (default 10, max 50).'),
          qmode: z.enum(['titleCreatorYear', 'everything', 'regex']).optional().default('titleCreatorYear')
            .describe('Zotero query mode. titleCreatorYear is best for natural-language lookup; ' +
              'everything is best for exact-string lookup like DOIs.'),
          item_type: z.string().optional()
            .describe('Filter by Zotero itemType, e.g. "journalArticle", "book", "preprint", "thesis". ' +
              'Omit to include all types.'),
        },
        async (args) => {
          try {
            const items = await searchZoteroLibrary(args.query, {
              limit: args.limit,
              qmode: args.qmode,
              itemType: args.item_type,
            });
            return ok(JSON.stringify({ count: items.length, items }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return fail(`Zotero search failed: ${message}`);
          }
        },
      ),

      tool(
        'get_item',
        'Fetch a single item from the local Zotero library by its key. Use the keys returned by ' +
        'search_library to pull full metadata for a specific reference.',
        {
          key: z.string().min(1)
            .describe('Zotero item key (e.g. "FRVYESGA"), as returned in the `key` field by search_library.'),
        },
        async (args) => {
          try {
            const item = await getZoteroItem(args.key);
            if (!item) return fail(`No Zotero item found with key ${args.key}.`);
            return ok(JSON.stringify(item));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return fail(`Zotero get_item failed: ${message}`);
          }
        },
      ),

      tool(
        'add_doi',
        'Add a reference to the local Zotero library by DOI. Launches Zotero if not already running, ' +
        'fetches metadata (CiteRight cache or Crossref), and saves the item via the connector. ' +
        'Use after the user picks a CiteRight result they want to keep in their library.',
        {
          doi: z.string().min(1)
            .describe('DOI of the publication (with or without https://doi.org/ prefix).'),
        },
        async (args) => {
          try {
            const result = await addDoiToZotero(args.doi);
            if (!result.success) {
              return fail(`Failed to add DOI ${args.doi}: ${result.error ?? 'unknown error'} (status: ${result.status})`);
            }
            return ok(JSON.stringify({ success: true, doi: args.doi, status: result.status }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return fail(`Zotero add_doi failed: ${message}`);
          }
        },
      ),
    ],
  });
}
