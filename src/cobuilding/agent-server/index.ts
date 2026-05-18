/**
 * Agent Server — runs inside the Podman container.
 *
 * Wraps the Claude Agent SDK's query() in a thin HTTP/SSE server so the
 * Electron host can communicate with the agent over the network instead of
 * a piped subprocess.
 *
 * MCP tools are registered as in-process SDK servers. Each tool handler relays
 * the call to the Electron host via an SSE event and waits for the result via
 * a POST to /sessions/:id/mcp-result. This avoids container→host networking
 * issues on macOS podman.
 *
 * Endpoints:
 *   POST /sessions              — create a new agent session
 *   POST /sessions/:id/messages — send a user message (text + attachments)
 *   GET  /sessions/:id/events   — SSE stream of raw SDKMessages + mcp-call events
 *   POST /sessions/:id/stop     — interrupt / destroy a session
 *   POST /sessions/:id/mcp-result — deliver MCP tool call result from host
 *   GET  /health                — liveness check
 */

import {
  query,
  createSdkMcpServer,
  tool,
  type Query,
  type SDKUserMessage,
  type SDKMessage,
  type HookInput,
  type SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AGENT_MEMORY_SUBDIR } from '../shared/paths';
import { SUGGESTED_TASKS_TOOL_DEFS } from '../shared/suggestedTasksTools';


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfig {
  port: number;
  claudeBinaryPath: string;
  mcpServers: Record<string, { type: 'http'; url: string }>;
  anthropicApiKey: string;
  anthropicBaseURL?: string;
  model: string;
  systemPrompt: unknown;
  allowedTools: string[];
  settingSources: string[];
  soulMd?: string;
  docxGuidance?: string;
}

interface SessionState {
  sessionId: string;
  queryInstance: Query | null;
  messageQueue: MessageQueue<UserMessagePayload>;
  sseClients: Set<ServerResponse>;
  running: boolean;
  stopped: boolean;
  // Monotonic per-session counter stamped on every SSE event as `id:` so the
  // host can replay from a known cursor after a reconnect.
  eventSeq: number;
  // Ring buffer of the most recent 500 events (drop-oldest). Stays populated
  // even while clients are attached, so a reconnect with `Last-Event-Id` can
  // replay anything the client missed during the disconnect window.
  bufferedEvents: Array<{ id: number; event: string; data: unknown }>;
  pendingMcpCalls: Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>;
  // Server-side backstop for orphan sessions: if the host crashes / drops
  // its reference without calling /stop, the idle timer evicts the session
  // after IDLE_EVICTION_MS of inactivity.
  idleTimer: NodeJS.Timeout | null;
  // Monotonic ms timestamp of the last time `bumpActivity` actually re-armed
  // the timer. Throttles re-arming so a streaming turn doesn't pay
  // clearTimeout+setTimeout on every SSE event.
  lastBumpAt: number;
}

// Server-side idle eviction window. Host-side visibility cleanup is the
// primary mechanism; this catches orphans and reclaims subprocess memory
// from sessions the user opened but isn't actively engaging with. Short
// enough that an idle chat sitting open doesn't pin agent processes for
// long, with the host transparently recreating the session (resumed from
// sdk_session_id) the next time the user sends a message.
const IDLE_EVICTION_MS = 10 * 60 * 1000;
// Don't re-arm the idle timer more often than this. Within a single turn
// the agent can broadcast hundreds of SSE events per second, and each
// bumpActivity call costs a clearTimeout+setTimeout pair. The throttle
// is far smaller than IDLE_EVICTION_MS so the worst-case delay before
// eviction fires after the last real activity is bounded.
const BUMP_THROTTLE_MS = 30 * 1000;
// Reschedule window when the eviction check finds an MCP call in flight.
// The full IDLE_EVICTION_MS would mean a stalled MCP call delays eviction
// by 10+ minutes; this lets us re-check soon after the call resolves.
const BUSY_RECHECK_MS = 30 * 1000;

interface UserMessagePayload {
  text: string;
  attachments?: Array<{
    type: string;
    data?: string;
    mediaType?: string;
    filePath?: string;
    name?: string;
    title?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = '/data/.academia/agent.json';

function loadConfig(): AgentConfig {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as AgentConfig;
}

// ---------------------------------------------------------------------------
// Docx Protection Hook
// ---------------------------------------------------------------------------

async function docxProtectionHook(input: HookInput): Promise<SyncHookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const { tool_name, tool_input } = input;
  const toolInput = (tool_input ?? {}) as Record<string, unknown>;

  const pathFields = ['file_path', 'path', 'command'];
  for (const field of pathFields) {
    const val = toolInput[field];
    if (
      typeof val === 'string' &&
      val.includes('.docx') &&
      (tool_name === 'Bash'
        ? val.includes('unzip') || val.includes('zip') || val.includes('docx')
        : tool_name === 'Read' || tool_name === 'Write' || tool_name === 'Edit')
    ) {
      if (tool_name === 'Bash' && (val.includes('unzip') || val.includes('mkdir') || val.includes('zip '))) {
        return {
          decision: 'block',
          reason: 'Do not unpack or modify .docx files directly. Use the ms-word MCP tools (find_and_replace with Track Changes) to edit Word documents.',
        } as SyncHookJSONOutput;
      }
      if ((tool_name === 'Edit' || tool_name === 'Write') && (val.includes('document.xml') || val.includes('word/'))) {
        return {
          decision: 'block',
          reason: 'Do not edit .docx XML files directly. Use mcp__ms-word__find_and_replace with Track Changes enabled instead.',
        } as SyncHookJSONOutput;
      }
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// MCP Relay — register proxy tools that relay calls to the Electron host
// ---------------------------------------------------------------------------

function createMcpRelayHandler(
  state: SessionState,
  serverName: string,
  toolName: string,
) {
  return async (args: Record<string, unknown>) => {
    const callId = randomUUID();
    console.log(`[AgentServer] MCP relay: ${serverName}/${toolName} (callId=${callId})`);

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingMcpCalls.delete(callId);
        reject(new Error(`MCP call ${serverName}/${toolName} timed out after 120s`));
      }, 120_000);

      state.pendingMcpCalls.set(callId, {
        resolve: (result: unknown) => { clearTimeout(timeout); state.pendingMcpCalls.delete(callId); resolve(result); },
        reject: (error: Error) => { clearTimeout(timeout); state.pendingMcpCalls.delete(callId); reject(error); },
      });
    });

    // Broadcast the MCP call request via SSE
    broadcastSSE(state, 'mcp-call', {
      callId,
      serverName,
      toolName,
      args,
    });

    try {
      const result = await resultPromise;
      return result as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `MCP relay error: ${msg}` }], isError: true };
    }
  };
}

/**
 * Create all MCP proxy servers that relay calls to the Electron host.
 * Tool definitions are defined here — they match the host-side MCP servers.
 */
function createMcpRelayServers(state: SessionState) {
  const relay = (server: string, name: string) => createMcpRelayHandler(state, server, name);

  return {
    activity: createSdkMcpServer({
      name: 'activity',
      tools: [
        tool('query_activity',
          'Query the user\'s recent activity — browser pages visited and files edited/viewed. Returns raw session data for a time range.',
          {
            period: z.enum(['today', 'last_2h', 'last_24h', 'this_week']).optional().describe('Convenience shorthand for common time ranges. Ignored if "since" is provided.'),
            since: z.string().optional().describe('ISO timestamp for custom range start. Overrides "period".'),
            until: z.string().optional().describe('ISO timestamp for custom range end. Defaults to now.'),
            search: z.string().optional().describe('Filter results by title or URL/path content.'),
            source: z.string().optional().describe('Which sources to include: "browser", "file", or "all". Comma-separated. Defaults to "all".'),
          },
          relay('activity', 'query_activity'),
        ),
      ],
    }),

    notification: createSdkMcpServer({
      name: 'notification',
      tools: [
        tool('show_notification',
          'Show a native desktop notification to the user. Use this to alert about completed tasks or important updates.',
          {
            title: z.string().describe('The notification title.'),
            body: z.string().describe('The notification body text.'),
            navigation: z.object({
              type: z.enum(['thread', 'sidebar']).describe('The type of navigation action.'),
              threadId: z.string().optional().describe('Thread ID to navigate to (required for "thread" type).'),
              sidebarTab: z.enum(['home', 'tools', 'files', 'chats', 'debug', 'settings']).optional().describe('Sidebar tab to show.'),
            }).optional().describe('Optional navigation action when the user clicks the notification.'),
          },
          relay('notification', 'show_notification'),
        ),
      ],
    }),

    reaction: createSdkMcpServer({
      name: 'reaction',
      tools: [
        tool('create_reaction_thread',
          'Create a new reaction thread visible to the user in the Reactions tab.',
          {
            title: z.string().describe('A short, descriptive title summarizing the reaction content (e.g., "New CRISPR delivery method in Nature" or "Grant deadline approaching for NIH R01"). Do NOT use generic timestamps like "Reaction — date".'),
            message: z.string().describe('The full reaction message content (markdown text).'),
          },
          relay('reaction', 'create_reaction_thread'),
        ),
      ],
    }),

    'ms-word': createSdkMcpServer({
      name: 'ms-word',
      tools: [
        tool('get_file_path', 'Get the file path and name of the active Word document.', {}, relay('ms-word', 'get_file_path')),
        tool('get_text', 'Get the text content of the active Word document.', {
          offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0)'),
          limit: z.number().optional().describe('Max characters to return (default 8000)'),
        }, relay('ms-word', 'get_text')),
        tool('get_selection', 'Get the currently selected text in the active Word document.', {}, relay('ms-word', 'get_selection')),
        tool('save_document', 'Save the active Word document.', {}, relay('ms-word', 'save_document')),
        tool('open_document', 'Open (or focus) a Word document by file path.', {
          path: z.string().describe('Absolute path to the .docx file to open'),
        }, relay('ms-word', 'open_document')),
        tool('find_and_replace', 'Propose a text edit in the active Word document. The edit is NOT applied immediately — the user sees a suggestion card and approves or denies. Call once per edit.', {
          search_text: z.string().describe('The exact text to find'),
          replacement_text: z.string().describe('The text to replace it with'),
          replace_scope: z.enum(['first', 'all']).default('first').describe('"first" or "all"'),
          match_case: z.boolean().default(true).describe('Case-sensitive search'),
        }, relay('ms-word', 'find_and_replace')),
      ],
    }),

    citeright: createSdkMcpServer({
      name: 'citeright',
      tools: [
        tool('find_references', 'Find verified references for a passage, claim, or whole document. Polls until done. Pass document_text or file_path (exactly one required).', {
          document_text: z.string().optional().describe('Passage or excerpt to find references for.'),
          file_path: z.string().optional().describe('Path to a .pdf or .docx file to upload.'),
          timeout_seconds: z.number().optional().default(600).describe('Max seconds to wait (default 600).'),
          poll_interval_seconds: z.number().optional().default(3).describe('Seconds between polls (default 3).'),
        }, relay('citeright', 'find_references')),
        tool('create_citation_report', 'Submit document text to start a citation analysis.', {
          document_text: z.string().describe('The document or excerpt to analyze.'),
        }, relay('citeright', 'create_citation_report')),
        tool('get_citation_report', 'Fetch the current state of a citation report by id.', {
          report_id: z.union([z.string(), z.number()]).describe('Citation report id.'),
        }, relay('citeright', 'get_citation_report')),
        tool('add_claim_to_report', 'Add a manual claim to an existing citation report.', {
          report_id: z.union([z.string(), z.number()]),
          text: z.string().describe('The claim or query text.'),
        }, relay('citeright', 'add_claim_to_report')),
        tool('search_citations_for_claim', 'Run citation search for a specific claim within a report.', {
          report_id: z.union([z.string(), z.number()]),
          claim_id: z.string(),
        }, relay('citeright', 'search_citations_for_claim')),
        tool('format_citations', 'Format work metadata into citation strings (apa, mla, chicago, harvard, ieee).', {
          works: z.array(z.object({
            title: z.string(),
            authors: z.array(z.union([z.object({ first_name: z.string().optional(), last_name: z.string().optional(), full_name: z.string().optional() }), z.string()])).optional(),
            publication: z.string().optional(),
            publication_year: z.union([z.string(), z.number()]).optional(),
            doi: z.string().optional(),
            url: z.string().optional(),
          }).passthrough()).describe('Works to format (max 50).'),
        }, relay('citeright', 'format_citations')),
        tool('list_citation_reports', 'List recent citation reports (paginated).', {
          page: z.number().optional().default(1),
          per_page: z.number().optional().default(10),
        }, relay('citeright', 'list_citation_reports')),
      ],
    }),

    'mini-apps': createSdkMcpServer({
      name: 'mini-apps',
      tools: [
        tool('open_mini_application',
          'Open an existing, already-built mini-application in the UI. The mini-application will take over the center content area and the chat will move to the right sidebar. Use this when the user asks to open an app that already has a built bundle. After creating or editing a mini-app, use build_and_open_mini_application instead so the latest source is bundled before display.',
          { dir_name: z.string().describe('The directory name of the mini-application (lowerCamelCase name under .applications/)') },
          relay('mini-apps', 'open_mini_application'),
        ),
        tool('build_and_open_mini_application',
          'Bundle a mini-application with esbuild and open it in the UI in one atomic step. Use this after creating a new mini-app, or after editing an existing app whose changes you want the user to see. If the build fails, the tool returns the esbuild error so you can fix the source and call again.',
          { dir_name: z.string().describe('The directory name of the mini-application (lowerCamelCase name under .applications/)') },
          relay('mini-apps', 'build_and_open_mini_application'),
        ),
      ],
    }),

    'google-docs': createSdkMcpServer({
      name: 'google-docs',
      tools: [
        tool('get_active_doc',
          "Get the document path, URL, and display title of the Google Doc currently open in the user's focused Chrome tab. Returns success=false when no Google Doc is active or the Academia browser extension is not connected.",
          {},
          relay('google-docs', 'get_active_doc'),
        ),
        tool('get_text',
          "Read the active Google Doc. By default returns the full doc body in a single call (up to 200,000 characters) via the OAuth-backed Docs API. Pass selection_only:true to get just the user's current text selection instead.",
          {
            selection_only: z.boolean().optional().describe("If true, return only the user's current selection. Default: false."),
            offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0). Ignored when selection_only=true.'),
            limit: z.number().optional().describe('Max characters to return (default 200000). Ignored when selection_only=true.'),
          },
          relay('google-docs', 'get_text'),
        ),
        tool('find_and_replace',
          'Propose a text edit in the active Google Doc. The edit is NOT applied automatically — the user sees a suggestion card with the diff. Call this tool once per edit. Do NOT describe the edits in your text — the UI shows them automatically.',
          {
            search_text: z.string().describe('The exact text to find in the doc'),
            replacement_text: z.string().describe('The text to replace it with'),
            replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
            match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
          },
          relay('google-docs', 'find_and_replace'),
        ),
      ],
    }),

    'apple-notes': createSdkMcpServer({
      name: 'apple-notes',
      tools: [
        tool('get_active_note',
          'Get the id and name of the currently selected note in Apple Notes. Returns null when no note is selected.',
          {},
          relay('apple-notes', 'get_active_note'),
        ),
        tool('get_text',
          'Get the plain-text content of an Apple Note. Defaults to the active note. Supports pagination via offset/limit.',
          {
            note_id: z.string().optional().describe('Apple Notes id (x-coredata://...). Defaults to the currently selected note.'),
            offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0)'),
            limit: z.number().optional().describe('Max characters to return (default 8000)'),
          },
          relay('apple-notes', 'get_text'),
        ),
        tool('list_notes',
          'List Apple Notes by most-recently-modified, paginated. Returns id, name, and modification date.',
          {
            offset: z.number().optional().describe('Pagination offset (0-based, default 0)'),
            limit: z.number().optional().describe('Max notes to return (default 50)'),
          },
          relay('apple-notes', 'list_notes'),
        ),
        tool('search_notes',
          "Search Apple Notes for a query string in note titles and bodies. Returns up to `limit` matches with id, name, and modification date.",
          {
            query: z.string().describe('Text to search for in note titles and bodies'),
            limit: z.number().optional().describe('Max matches to return (default 50)'),
          },
          relay('apple-notes', 'search_notes'),
        ),
        tool('save_note',
          'Save an Apple Note. Apple Notes saves automatically — this is a no-op kept for parity with the Word/Obsidian flow.',
          {
            note_id: z.string().optional().describe('Apple Notes id. Defaults to the active note.'),
          },
          relay('apple-notes', 'save_note'),
        ),
        tool('open_note',
          'Open (focus) a note in Apple Notes by id. Brings the Notes window forward and selects that note.',
          {
            note_id: z.string().describe('Apple Notes id (x-coredata://...).'),
          },
          relay('apple-notes', 'open_note'),
        ),
        tool('find_and_replace',
          'Propose a text edit in an Apple Note. The edit is NOT applied immediately — the user sees a suggestion card and approves or denies each edit. Call this tool once per edit. Do NOT describe the edits in your text — the UI shows them automatically.',
          {
            search_text: z.string().describe('The exact text to find in the note'),
            replacement_text: z.string().describe('The text to replace it with'),
            replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
            match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
            note_id: z.string().optional().describe('Apple Notes id. Defaults to the active note.'),
          },
          relay('apple-notes', 'find_and_replace'),
        ),
      ],
    }),

    obsidian: createSdkMcpServer({
      name: 'obsidian',
      tools: [
        tool('get_active_note',
          'Get the path of the currently active note in Obsidian. Returns null if no markdown note is active.',
          {},
          relay('obsidian', 'get_active_note'),
        ),
        tool('get_text',
          'Read the contents of a markdown note in the workspace. Defaults to the active note. Supports pagination via offset/limit.',
          {
            path: z.string().optional().describe('Absolute path to the .md file to read. Defaults to the active note.'),
            offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0)'),
            limit: z.number().optional().describe('Max characters to return (default 8000)'),
          },
          relay('obsidian', 'get_text'),
        ),
        tool('list_notes',
          'List all markdown notes in the workspace/vault. Returns relative paths.',
          {
            subdir: z.string().optional().describe('Optional subdirectory under the vault root to list (e.g. "daily").'),
          },
          relay('obsidian', 'list_notes'),
        ),
        tool('open_note',
          'Open (focus) a note in Obsidian by absolute path.',
          {
            path: z.string().describe('Absolute path to the .md file inside the vault.'),
          },
          relay('obsidian', 'open_note'),
        ),
        tool('find_and_replace',
          'Propose a text edit in a markdown note. The edit is NOT applied immediately — the user sees a suggestion card and approves or denies each edit. Approved edits are written to disk and Obsidian auto-reloads the buffer. Call this tool once per edit. Do NOT describe the edits in your text — the UI shows them automatically.',
          {
            search_text: z.string().describe('The exact text to find in the note'),
            replacement_text: z.string().describe('The text to replace it with'),
            replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
            match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
            path: z.string().optional().describe('Absolute path to the .md file. Defaults to the active note.'),
          },
          relay('obsidian', 'find_and_replace'),
        ),
      ],
    }),

    zotero: createSdkMcpServer({
      name: 'zotero',
      tools: [
        tool('status', 'Check whether the local Zotero desktop client is running and reachable.', {}, relay('zotero', 'status')),
        tool('search_library', 'Search the user\'s local Zotero library by query string.', {
          query: z.string().describe('Search query'),
          limit: z.number().optional().default(10).describe('Max results to return'),
        }, relay('zotero', 'search_library')),
        tool('get_item', 'Get a specific item from the Zotero library by key.', {
          key: z.string().describe('Zotero item key'),
        }, relay('zotero', 'get_item')),
        tool('add_doi', 'Add a publication to the Zotero library by DOI.', {
          doi: z.string().describe('DOI of the publication to add'),
        }, relay('zotero', 'add_doi')),
      ],
    }),

    grants: createSdkMcpServer({
      name: 'grants',
      tools: [
        tool('save_user_context',
          'Save user profile data to improve grant matching quality. Call before creating a project if user context is available. Each question/response pair is upserted.',
          {
            data: z.array(z.object({
              question: z.enum([
                'What type of organization are you affiliated with?',
                'Where is your research institution located?',
                'What best describes your field of research?',
                'What title best describes you?',
                'How many grants did you apply for in the last 12 months?',
                'How many years of professional experience do you have?',
              ]).describe('Must be one of the predefined onboarding questions.'),
              response: z.string().describe('The user\'s answer.'),
            })).min(1).describe('Array of question/response pairs to save.'),
          },
          relay('grants', 'save_user_context'),
        ),
        tool('create_project',
          'Create a grant project and trigger the matching pipeline. Results appear asynchronously — use get_project to poll. More detailed research summaries produce better matches.',
          {
            research_summary: z.string().min(1).describe('Detailed description of research focus, methodology, and goals.'),
            name: z.string().optional().describe('Optional project name. Auto-generated if omitted.'),
          },
          relay('grants', 'create_project'),
        ),
        tool('get_project',
          'Get a grant project with matched opportunities. Poll after creating a project until results stabilize (2-5 minutes). Only opportunities with score > 3 are returned.',
          {
            project_id: z.number().int().describe('The project ID returned by create_project.'),
          },
          relay('grants', 'get_project'),
        ),
        tool('list_projects', 'List all grant projects for the current user.', {},
          relay('grants', 'list_projects'),
        ),
        tool('favorite_opportunity', 'Save or unsave a grant opportunity for later reference.', {
          project_id: z.number().int(),
          grant_opportunity_id: z.number().int(),
          favorite: z.boolean().describe('true to save, false to unsave.'),
        }, relay('grants', 'favorite_opportunity')),
        tool('hide_opportunity', 'Dismiss or un-dismiss a grant opportunity.', {
          project_id: z.number().int(),
          grant_opportunity_id: z.number().int(),
          hidden: z.boolean().describe('true to hide, false to un-hide.'),
        }, relay('grants', 'hide_opportunity')),
        tool('set_hidden_reason', 'Record why a grant opportunity was dismissed. Call after hide_opportunity.', {
          project_id: z.number().int(),
          grant_opportunity_id: z.number().int(),
          hidden_reason: z.string().min(1).describe('Why the opportunity was dismissed.'),
        }, relay('grants', 'set_hidden_reason')),
        tool('visit_opportunity', 'Mark a grant opportunity as visited. Clears the "new" indicator.', {
          project_id: z.number().int(),
          grant_opportunity_id: z.number().int(),
        }, relay('grants', 'visit_opportunity')),
        tool('update_project', 'Update a grant project name or research summary. Does NOT re-trigger matching — create a new project for a new search.', {
          project_id: z.number().int(),
          name: z.string().optional(),
          research_summary: z.string().optional(),
        }, relay('grants', 'update_project')),
      ],
    }),

    'suggested-tasks': (() => {
      const d = SUGGESTED_TASKS_TOOL_DEFS;
      return createSdkMcpServer({
        name: 'suggested-tasks',
        tools: [
          tool('list_suggestions', d.list_suggestions.description, d.list_suggestions.schema, relay('suggested-tasks', 'list_suggestions')),
          tool('create_suggestion', d.create_suggestion.description, d.create_suggestion.schema, relay('suggested-tasks', 'create_suggestion')),
          tool('update_suggestion', d.update_suggestion.description, d.update_suggestion.schema, relay('suggested-tasks', 'update_suggestion')),
          tool('reorder_suggestions', d.reorder_suggestions.description, d.reorder_suggestions.schema, relay('suggested-tasks', 'reorder_suggestions')),
          tool('delete_suggestion', d.delete_suggestion.description, d.delete_suggestion.schema, relay('suggested-tasks', 'delete_suggestion')),
        ],
      });
    })(),

    workspace: createSdkMcpServer({
      name: 'workspace',
      tools: [
        tool('get_scanned_files',
          'List files discovered in the workspace during the onboarding scan, with their type tags (manuscript, grant, presentation, reference). Optionally filter by file_type.',
          {
            file_type: z.enum(['manuscript', 'grant', 'presentation', 'reference']).optional()
              .describe('Filter results to a specific file type. Returns all types if omitted.'),
          },
          relay('workspace', 'get_scanned_files'),
        ),
        tool('get_research_profile',
          'Get the user\'s research profile generated during the workspace onboarding scan. Returns a summary of who the user is, their research field, and what they are currently working on.',
          {},
          relay('workspace', 'get_research_profile'),
        ),
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// Async Message Queue
// ---------------------------------------------------------------------------

interface MessageQueue<T> {
  push(item: T): void;
  done(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

function createMessageQueue<T>(): MessageQueue<T> {
  const pending: T[] = [];
  let resolve: (() => void) | null = null;
  let isDone = false;

  return {
    push(item: T) {
      pending.push(item);
      if (resolve) { const r = resolve; resolve = null; r(); }
    },
    done() {
      isDone = true;
      if (resolve) { const r = resolve; resolve = null; r(); }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (pending.length > 0) return Promise.resolve({ value: pending.shift()!, done: false });
          if (isDone) return Promise.resolve({ value: undefined as unknown as T, done: true });
          return new Promise<IteratorResult<T>>((r) => {
            resolve = () => {
              if (pending.length > 0) r({ value: pending.shift()!, done: false });
              else r({ value: undefined as unknown as T, done: true });
            };
          });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionState>();

function buildSystemPrompt(config: AgentConfig): unknown {
  const appendParts = [config.soulMd, config.docxGuidance].filter(Boolean).join('\n\n');
  if (typeof config.systemPrompt === 'object' && config.systemPrompt !== null) {
    return { ...config.systemPrompt, append: appendParts } as unknown;
  }
  return config.systemPrompt;
}

async function* userMessageGenerator(queue: MessageQueue<UserMessagePayload>): AsyncGenerator<SDKUserMessage> {
  for await (const payload of queue) {
    const content = buildContentBlocks(payload);
    yield { type: 'user', message: { role: 'user', content } } as SDKUserMessage;
  }
}

function buildContentBlocks(payload: UserMessagePayload): string | unknown[] {
  const { text, attachments } = payload;
  if (!attachments || attachments.length === 0) return text;

  const blocks: unknown[] = [];
  for (const att of attachments) {
    if (att.type === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
    } else if (att.type === 'document') {
      if (att.mediaType === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.data }, title: att.title ?? null });
      } else {
        const textContent = Buffer.from(att.data!, 'base64').toString('utf-8');
        blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: textContent }, title: att.title ?? null });
      }
    } else if (att.type === 'file_reference') {
      blocks.push({ type: 'text', text: `[Attached file: ${att.filePath}]\nThis file has been placed in the workspace. You may need to preprocess it before use.` });
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

function createSession(sessionId: string, config: AgentConfig, resumeSessionId?: string): SessionState {
  const messageQueue = createMessageQueue<UserMessagePayload>();

  const state: SessionState = {
    sessionId,
    queryInstance: null,
    messageQueue,
    sseClients: new Set(),
    running: false,
    stopped: false,
    eventSeq: 0,
    bufferedEvents: [],
    pendingMcpCalls: new Map(),
    idleTimer: null,
    lastBumpAt: 0,
  };

  console.log(`[AgentServer] Creating session ${sessionId}`);

  const mcpRelayServers = createMcpRelayServers(state);

  async function startQuery(resume?: string): Promise<void> {
    state.running = true;
    console.log(`[AgentServer] Starting query() with model=${config.model}${resume ? `, resuming ${resume}` : ''}`);

    // Create a fresh generator each time — if we're retrying after a failed
    // resume, the previous generator was consumed by the failed query.
    const queryInstance = query({
      prompt: userMessageGenerator(messageQueue),
      options: {
        pathToClaudeCodeExecutable: config.claudeBinaryPath,
        stderr: (data: string) => {
          for (const line of data.split('\n').filter(Boolean)) {
            console.log(`[AgentServer:stderr] ${line}`);
          }
        },
        model: config.model,
        thinking: { type: 'adaptive' },
        systemPrompt: buildSystemPrompt(config) as any,
        ...(resume && { resume }),
        includePartialMessages: true,
        cwd: '/data',
        env: {
          // Inherit the container's full environment (PATH, NODE_PATH, VIRTUAL_ENV, etc.)
          // so the subprocess can find system binaries (ls, grep, python3, etc.)
          ...process.env,
          ANTHROPIC_API_KEY: config.anthropicApiKey,
          ...(config.anthropicBaseURL ? { ANTHROPIC_BASE_URL: config.anthropicBaseURL } : {}),
          MINI_APP_WORKSPACE_DIR: '/data',
          COBUILDING_INSIDE_CONTAINER: '1',
          CLAUDE_CONFIG_DIR: '/data/.academia/claude-config',
        },
        settingSources: config.settingSources as any[],
        settings: {
          autoMemoryEnabled: true,
          autoMemoryDirectory: `/data/${AGENT_MEMORY_SUBDIR}`,
        },
        mcpServers: mcpRelayServers as any,
        allowedTools: config.allowedTools,
        hooks: {
          PreToolUse: [{ hooks: [docxProtectionHook] }],
        },
      },
    });

    state.queryInstance = queryInstance;

    for await (const message of queryInstance) {
      broadcastSSE(state, 'message', message);
    }

    broadcastSSE(state, 'done', {});
  }

  (async () => {
    try {
      // Check if the session exists in CLAUDE_CONFIG_DIR before attempting resume.
      // This avoids consuming the user's message in a doomed query() that fails
      // on "No conversation found" and can't be retried (message already consumed).
      let validResume = resumeSessionId;
      if (validResume) {
        const fileExists = existsSync, readDir = readdirSync;
        const configDir = '/data/.academia/claude-config';
        // SDK stores sessions in {CLAUDE_CONFIG_DIR}/projects/{projectKey}/{sessionId}.jsonl
        let found = false;
        const projectsDir = `${configDir}/projects`;
        if (fileExists(projectsDir)) {
          try {
            for (const proj of readDir(projectsDir)) {
              if (fileExists(`${projectsDir}/${proj}/${validResume}.jsonl`)) {
                found = true;
                break;
              }
            }
          } catch { /* ignore */ }
        }
        if (!found) {
          console.log(`[AgentServer] Session ${validResume} not found in config dir, starting fresh`);
          validResume = undefined;
        }
      }
      await startQuery(validResume);
    } catch (err: unknown) {
      if (state.stopped) {
        broadcastSSE(state, 'done', {});
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        broadcastSSE(state, 'error', { error: errorMessage });
      }
    } finally {
      state.running = false;
      state.queryInstance = null;
    }
  })();

  sessions.set(sessionId, state);
  bumpActivity(sessionId, state);
  return state;
}

const SSE_RING_BUFFER_SIZE = 500;

/**
 * Resets the idle eviction timer. Called on every signal of activity
 * (inbound POST, outbound SSE event). Re-arming is throttled by
 * BUMP_THROTTLE_MS because a streaming turn can fire hundreds of SSE
 * events per second and the timer doesn't need that resolution.
 *
 * The state.running flag tracks the lifetime of the query() loop, not
 * per-turn activity — it stays true while the loop is idle-waiting for
 * the next user message. So we gate eviction on `pendingMcpCalls`
 * instead: an in-flight tool call means the agent is blocked on the
 * host, not actually idle.
 */
function bumpActivity(sessionId: string, state: SessionState): void {
  const now = Date.now();
  if (state.idleTimer && now - state.lastBumpAt < BUMP_THROTTLE_MS) return;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.lastBumpAt = now;
  state.idleTimer = setTimeout(() => {
    const current = sessions.get(sessionId);
    if (!current || current !== state) return;
    if (state.stopped) return;
    if (state.pendingMcpCalls.size > 0) {
      // Don't evict mid tool-call. Reschedule with a short window so we
      // re-check soon after the call resolves rather than waiting a full
      // IDLE_EVICTION_MS, which would delay eviction by 10+ minutes if
      // the call hangs.
      state.idleTimer = setTimeout(() => bumpActivity(sessionId, state), BUSY_RECHECK_MS);
      return;
    }
    console.log(`[AgentServer] Idle eviction firing for session ${sessionId} after ${IDLE_EVICTION_MS}ms`);
    state.stopped = true;
    // Closing queryInstance unblocks startQuery's for-await, which then
    // broadcasts a 'done' event to attached SSE clients. The host treats
    // that as a clean session-end and will recreate-with-resume on the
    // next user message.
    if (state.queryInstance) {
      state.queryInstance.close();
      state.queryInstance = null;
    }
    state.messageQueue.done();
    sessions.delete(sessionId);
  }, IDLE_EVICTION_MS);
}

function broadcastSSE(state: SessionState, event: string, data: unknown): void {
  if (event === 'error') {
    console.error(`[AgentServer] Broadcasting error:`, JSON.stringify(data));
  }

  // Any outbound activity counts as a liveness signal for idle eviction.
  // Without this, the timer set on the last inbound POST would expire
  // mid-turn even though the agent is actively producing output.
  bumpActivity(state.sessionId, state);

  const id = ++state.eventSeq;

  // Always retain the event in the ring buffer (drop oldest at cap) so a
  // reconnect with `Last-Event-Id` can replay missed events, regardless of
  // whether any client is currently attached.
  state.bufferedEvents.push({ id, event, data });
  if (state.bufferedEvents.length > SSE_RING_BUFFER_SIZE) {
    state.bufferedEvents.shift();
  }

  if (state.sseClients.size === 0) return;

  const payload = formatSSEEvent(id, event, data);
  for (const client of state.sseClients) {
    client.write(payload);
    if (event === 'done' || event === 'error') {
      client.end();
    }
  }
  if (event === 'done' || event === 'error') {
    state.sseClients.clear();
  }
}

function formatSSEEvent(id: number, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseRoute(url: string): { path: string; sessionId?: string; action?: string } {
  const parts = url.split('/').filter(Boolean);
  if (parts[0] === 'health') return { path: 'health' };
  if (parts[0] === 'sessions') {
    if (parts.length === 1) return { path: 'sessions' };
    if (parts.length === 3) return { path: 'session-action', sessionId: parts[1], action: parts[2] };
  }
  return { path: 'unknown' };
}

function startServer(config: AgentConfig): void {
  const server = createServer(async (req, res) => {
    const route = parseRoute(req.url ?? '/');

    try {
      if (route.path === 'health' && req.method === 'GET') {
        sendJSON(res, 200, { status: 'ok', sessions: sessions.size });
        return;
      }

      if (route.path === 'sessions' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const sessionId = body.sessionId ?? randomUUID();
        const resumeSessionId = body.resumeSessionId;
        createSession(sessionId, config, resumeSessionId);
        sendJSON(res, 201, { sessionId });
        return;
      }

      if (route.path === 'session-action' && route.sessionId) {
        const state = sessions.get(route.sessionId);
        if (!state) {
          sendJSON(res, 404, { error: 'Session not found' });
          return;
        }

        // POST /sessions/:id/messages
        if (route.action === 'messages' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          // messageId is a host-generated correlation id for the turn. We just
          // log it here so an engineer grepping for the id can see when the
          // container received the corresponding POST.
          console.log(`[AgentServer] message received sessionId=${route.sessionId} messageId=${body.messageId ?? '(none)'} textLen=${(body.text ?? '').length}`);
          state.messageQueue.push({ text: body.text ?? '', attachments: body.attachments });
          bumpActivity(route.sessionId, state);
          sendJSON(res, 200, { ok: true });
          return;
        }

        // GET /sessions/:id/events
        if (route.action === 'events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.socket?.setNoDelay(true);
          res.write(':ok\n\n');
          state.sseClients.add(res);

          // Replay events the client hasn't seen yet. `Last-Event-Id` is the
          // last id the client processed; we resume from id+1. If the client
          // has no cursor (fresh connect), replay the entire buffer.
          const lastEventIdHeader = req.headers['last-event-id'];
          const lastEventId = typeof lastEventIdHeader === 'string' ? Number.parseInt(lastEventIdHeader, 10) : NaN;
          const resumeFrom = Number.isFinite(lastEventId) ? lastEventId : 0;
          let replayed = 0;
          for (const buffered of state.bufferedEvents) {
            if (buffered.id <= resumeFrom) continue;
            res.write(formatSSEEvent(buffered.id, buffered.event, buffered.data));
            replayed++;
            if (buffered.event === 'done' || buffered.event === 'error') {
              res.end();
              state.sseClients.delete(res);
              break;
            }
          }
          if (Number.isFinite(lastEventId)) {
            console.log(`[AgentServer] SSE reconnect sessionId=${route.sessionId} resumeFrom=${resumeFrom} replayed=${replayed}`);
          }

          req.on('close', () => { state.sseClients.delete(res); });
          return;
        }

        // POST /sessions/:id/mcp-result — deliver MCP tool call result from host
        if (route.action === 'mcp-result' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          const { callId, result, error } = body;
          const pending = state.pendingMcpCalls.get(callId);
          if (pending) {
            if (error) {
              pending.reject(new Error(error));
            } else {
              pending.resolve(result);
            }
          }
          bumpActivity(route.sessionId, state);
          sendJSON(res, 200, { ok: true });
          return;
        }

        // POST /sessions/:id/stop
        if (route.action === 'stop' && req.method === 'POST') {
          state.stopped = true;
          if (state.idleTimer) {
            clearTimeout(state.idleTimer);
            state.idleTimer = null;
          }
          if (state.queryInstance) {
            state.queryInstance.close();
            state.queryInstance = null;
          }
          state.messageQueue.done();
          // Reject all pending MCP calls
          for (const [, pending] of state.pendingMcpCalls) {
            pending.reject(new Error('Session stopped'));
          }
          state.pendingMcpCalls.clear();
          sessions.delete(route.sessionId);
          sendJSON(res, 200, { ok: true });
          return;
        }
      }

      sendJSON(res, 404, { error: 'Not found' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AgentServer] Error handling ${req.method} ${req.url}:`, msg);
      sendJSON(res, 500, { error: msg });
    }
  });

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[AgentServer] Listening on 0.0.0.0:${config.port}`);
  });

  process.on('SIGTERM', () => {
    console.log('[AgentServer] SIGTERM received, shutting down...');
    for (const [id, state] of sessions) {
      state.stopped = true;
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.queryInstance?.close();
      state.messageQueue.done();
      for (const [, pending] of state.pendingMcpCalls) {
        pending.reject(new Error('Server shutting down'));
      }
      sessions.delete(id);
    }
    server.close(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

// Set CLAUDE_CONFIG_DIR at the process level so the SDK parent process
// (which handles session load/resume) uses the persistent workspace mount.
// The subprocess also receives it via the query() env option.
process.env.CLAUDE_CONFIG_DIR = '/data/.academia/claude-config';

const config = loadConfig();
startServer(config);
