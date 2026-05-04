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
import { readFileSync } from 'fs';
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
          'Query the user\'s recent activity — browser pages visited, files edited/viewed, and dictated notes. Returns raw session data for a time range.',
          {
            period: z.enum(['today', 'last_2h', 'last_24h', 'this_week']).optional().describe('Convenience shorthand for common time ranges. Ignored if "since" is provided.'),
            since: z.string().optional().describe('ISO timestamp for custom range start. Overrides "period".'),
            until: z.string().optional().describe('ISO timestamp for custom range end. Defaults to now.'),
            search: z.string().optional().describe('Filter results by title or URL/path content.'),
            source: z.string().optional().describe('Which sources to include: "browser", "file", "notes", or "all". Comma-separated. Defaults to "all".'),
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
              sidebarTab: z.enum(['chats', 'files', 'apps', 'scheduled', 'reactions', 'debug']).optional().describe('Sidebar tab to show.'),
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
          'Open an existing mini-application in the UI. The mini-application will take over the center content area and the chat will move to the right sidebar.',
          { dir_name: z.string().describe('The directory name of the mini-application (lowerCamelCase name under .applications/)') },
          relay('mini-apps', 'open_mini_application'),
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
    queryInstance: null,
    messageQueue,
    sseClients: new Set(),
    running: false,
    stopped: false,
    bufferedEvents: [],
    pendingMcpCalls: new Map(),
  };

  console.log(`[AgentServer] Creating session ${sessionId}`);

  // Create MCP relay servers (tool handlers broadcast via SSE and wait for result)
  const mcpRelayServers = createMcpRelayServers(state);

  // Diagnostic: check binary
  try {
    const { statSync } = require('fs');
    const binaryStat = statSync(config.claudeBinaryPath);
    console.log(`[AgentServer] Binary exists: size=${binaryStat.size}, mode=${binaryStat.mode.toString(8)}`);
  } catch (e: any) {
    console.error(`[AgentServer] Binary NOT found: ${e.message}`);
  }

  (async () => {
    try {
      state.running = true;
      console.log(`[AgentServer] Starting query() with model=${config.model}`);

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
          ...(resumeSessionId && { resume: resumeSessionId }),
          includePartialMessages: true,
          cwd: '/data',
          env: {
            ANTHROPIC_API_KEY: config.anthropicApiKey,
            MINI_APP_WORKSPACE_DIR: '/data',
            COBUILDING_INSIDE_CONTAINER: '1',
          },
          settingSources: config.settingSources as any[],
          mcpServers: mcpRelayServers as any,
          allowedTools: config.allowedTools,
          hooks: {
            PreToolUse: [{ hooks: [docxProtectionHook] }],
          },
          persistSession: false,
        },
      });

      state.queryInstance = queryInstance;

      for await (const message of queryInstance) {
        broadcastSSE(state, 'message', message);
      }

      broadcastSSE(state, 'done', {});
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
    state.bufferedEvents.push({ event, data });
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

const config = loadConfig();
startServer(config);
