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
  queryInstance: Query | null;
  messageQueue: MessageQueue<UserMessagePayload>;
  sseClients: Set<ServerResponse>;
  running: boolean;
  stopped: boolean;
  bufferedEvents: Array<{ event: string; data: unknown }>;
  pendingMcpCalls: Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>;
}

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
            title: z.string().describe('Title for the reaction thread.'),
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
        tool('track_changes_status', 'Check whether Track Changes is enabled on the active Word document.', {}, relay('ms-word', 'track_changes_status')),
        tool('set_track_changes', 'Enable or disable Track Changes on the active Word document.', {
          enabled: z.boolean().describe('true to enable, false to disable'),
        }, relay('ms-word', 'set_track_changes')),
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
    queryInstance: null,
    messageQueue,
    sseClients: new Set(),
    running: false,
    stopped: false,
    bufferedEvents: [],
    pendingMcpCalls: new Map(),
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
  return state;
}

function broadcastSSE(state: SessionState, event: string, data: unknown): void {
  if (event === 'error') {
    console.error(`[AgentServer] Broadcasting error:`, JSON.stringify(data));
  }

  if (state.sseClients.size === 0) {
    // Cap buffer to prevent unbounded growth if SSE client is slow to connect
    if (state.bufferedEvents.length < 500) {
      state.bufferedEvents.push({ event, data });
    }
    return;
  }

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
          state.messageQueue.push({ text: body.text ?? '', attachments: body.attachments });
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
          res.write(':ok\n\n');
          state.sseClients.add(res);

          // Replay buffered events
          for (const buffered of state.bufferedEvents) {
            const payload = `event: ${buffered.event}\ndata: ${JSON.stringify(buffered.data)}\n\n`;
            res.write(payload);
            if (buffered.event === 'done' || buffered.event === 'error') {
              res.end();
              state.sseClients.delete(res);
            }
          }
          state.bufferedEvents = [];

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
          sendJSON(res, 200, { ok: true });
          return;
        }

        // POST /sessions/:id/stop
        if (route.action === 'stop' && req.method === 'POST') {
          state.stopped = true;
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
