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
} from '@anthropic-ai/claude-agent-sdk';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AGENT_MEMORY_SUBDIR } from '../shared/paths';
import { OAUTH_FLOW_WINDOW_MS } from '../shared/oauthWindow';
import { replaceConnectorAllowedTools } from '../shared/connectors';
import { mergeSessionConfig, filterMcpServers, type AgentConfig, type SessionOverrides } from './sessionConfig';
import { ensureApiKeyApproved } from '../shared/claudeConfigApproval';


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  // Acabox's own MCP relay servers for this session, already filtered by
  // allowedTools. Kept on the session because `setMcpServers` REPLACES the
  // whole dynamic set — see applyConnectorsToSession.
  mcpRelayServers: Record<string, unknown>;
  // User connectors (Settings → Connectors) currently applied to this session,
  // in the SDK's McpServerConfig shape.
  mcpConnectors: Record<string, Record<string, unknown>>;
}

// Server-side idle eviction window. Host-side visibility cleanup is the
// primary mechanism; this catches orphans and reclaims subprocess memory
// from sessions the user opened but isn't actively engaging with. Short
// enough that an idle chat sitting open doesn't pin agent processes for
// long, with the host transparently recreating the session (resumed from
// sdk_session_id) the next time the user sends a message.
//
// LOAD-BEARING LOWER BOUND: this must stay comfortably above
// OAUTH_FLOW_WINDOW_MS. A connector OAuth handshake leaves a callback listener
// and a PKCE verifier in this session's CLI subprocess and then the turn ends,
// so the session sits *idle by this timer's definition* for the whole time the
// user is away in their browser. The host pins the session for
// OAUTH_FLOW_WINDOW_MS to survive that; evicting underneath the pin would kill
// the subprocess anyway and resurrect the exact bug the pin fixes. There is
// deliberately no pin-awareness here — an ordering invariant between two
// constants is far less machinery than a second lifetime protocol across the
// process boundary, and the assertion below makes a bad edit fail loudly at
// boot instead of silently in the field.
const IDLE_EVICTION_MS = 10 * 60 * 1000;
if (IDLE_EVICTION_MS <= OAUTH_FLOW_WINDOW_MS) {
  throw new Error(
    `IDLE_EVICTION_MS (${IDLE_EVICTION_MS}ms) must exceed OAUTH_FLOW_WINDOW_MS `
    + `(${OAUTH_FLOW_WINDOW_MS}ms): idle eviction would kill the CLI subprocess mid-OAuth-handshake, `
    + 'breaking every connector sign-in. Raise IDLE_EVICTION_MS or shorten the OAuth window.',
  );
}
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

function loadConfig(): AgentConfig {
  const configPath = process.env.COSCIENTIST_AGENT_CONFIG || '/data/.academia/agent.json';
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as AgentConfig;
}

function getWorkspaceRoot(): string {
  return process.env.COSCIENTIST_WORKSPACE || '/data';
}

/**
 * Claude Code's config dir — approved API keys, MCP OAuth tokens, session
 * transcripts. The host injects it (userData, outside the workspace) because
 * the agent has Read/Write/Bash on the workspace and must not be able to read
 * connector OAuth tokens. The fallback is the pre-2026-07-28 in-workspace
 * location, so a standalone run of this bundle still works.
 */
function getClaudeConfigDir(): string {
  return process.env.COSCIENTIST_CLAUDE_CONFIG_DIR
    || `${getWorkspaceRoot()}/.academia/claude-config`;
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
        tool('list_published_servers',
          'List MCP servers currently published by other open mini-applications. Each entry includes serverName, dirName, and the tools the mini-app exposes (name + description + input schema). Use this to discover what callable services other mini-apps offer before invoking them.',
          {},
          relay('mini-apps', 'list_published_servers'),
        ),
        tool('call_published_tool',
          'Invoke a tool exposed by another open mini-application. The target mini-app must be currently loaded in the UI (its iframe registers when shown, unregisters when closed). The result is whatever JSON the mini-app returns.',
          {
            server_name: z.string().describe('serverName from list_published_servers'),
            tool_name: z.string().describe('name of the tool to invoke (from the server\'s tools list)'),
            arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments matching the tool\'s input_schema'),
          },
          relay('mini-apps', 'call_published_tool'),
        ),
      ],
    }),

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
  const appendParts = [config.soulMd, config.docxGuidance, config.workspaceDirectoriesGuidance].filter(Boolean).join('\n\n');
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

function createSession(sessionId: string, config: AgentConfig, resumeSessionId?: string, overrides?: SessionOverrides): SessionState {
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
    mcpRelayServers: {},
    mcpConnectors: {},
  };

  console.log(`[AgentServer] Creating session ${sessionId}`);

  const mcpRelayServers = createMcpRelayServers(state);

  const sessionConfig = mergeSessionConfig(config, overrides);

  // Snapshot both halves of the MCP server set onto the session. The relay
  // half is fixed for the session's lifetime; the connector half is replaced
  // live by POST /connectors.
  state.mcpRelayServers = filterMcpServers(mcpRelayServers, sessionConfig.allowedTools);
  state.mcpConnectors = config.mcpServers ?? {};

  async function startQuery(resume?: string): Promise<void> {
    // Defence in depth behind the host's chat:send guard. The key is snapshotted
    // into sessionConfig at createSession() time and POST /credentials only
    // updates currentConfig, so a session born before the key landed stays
    // keyless. Handing '' to the SDK blanks any inherited ANTHROPIC_API_KEY
    // (see the env spread below) and the CLI replies "Not logged in · Please
    // run /login". Refuse instead — the throw is caught by the caller and
    // broadcast as an 'error' SSE, which the host forwards to chat:error.
    // Wording must stay 401/token-free so isAuthError() doesn't swallow it as a
    // retryable auth failure. Keep in sync with NO_API_KEY_MESSAGE in
    // main/index.ts (separate bundle — no shared import).
    if (!sessionConfig.anthropicApiKey?.trim()) {
      throw new Error('No Anthropic API key configured. Add one in Settings.');
    }

    state.running = true;
    console.log(`[AgentServer] Starting query() with model=${sessionConfig.model}${resume ? `, resuming ${resume}` : ''}`);

    // Claude Code ignores an env ANTHROPIC_API_KEY it hasn't "approved" and
    // reports "Not logged in" — headless runs can't answer the interactive
    // approval prompt, so record the approval before every query.
    ensureApiKeyApproved(getClaudeConfigDir(), sessionConfig.anthropicApiKey);

    // Create a fresh generator each time — if we're retrying after a failed
    // resume, the previous generator was consumed by the failed query.
    const queryInstance = query({
      prompt: userMessageGenerator(messageQueue),
      options: {
        // Let the SDK auto-resolve the bundled Claude binary from the
        // platform-specific package (e.g. @anthropic-ai/claude-agent-sdk-darwin-arm64).
        ...(sessionConfig.claudeBinaryPath ? { pathToClaudeCodeExecutable: sessionConfig.claudeBinaryPath } : {}),
        stderr: (data: string) => {
          for (const line of data.split('\n').filter(Boolean)) {
            console.log(`[AgentServer:stderr] ${line}`);
          }
        },
        model: sessionConfig.model,
        thinking: { type: 'adaptive' },
        // Thinking level from the chat UI. Guides how much the model reasons
        // alongside adaptive thinking. Omitted → SDK/model default.
        ...(sessionConfig.effort ? { effort: sessionConfig.effort as any } : {}),
        systemPrompt: buildSystemPrompt(sessionConfig) as any,
        ...(resume && { resume }),
        includePartialMessages: true,
        cwd: getWorkspaceRoot(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: sessionConfig.anthropicApiKey,
          ...(sessionConfig.anthropicBaseURL ? { ANTHROPIC_BASE_URL: sessionConfig.anthropicBaseURL } : {}),
          MINI_APP_WORKSPACE_DIR: getWorkspaceRoot(),
          CLAUDE_CONFIG_DIR: getClaudeConfigDir(),
        },
        settingSources: sessionConfig.settingSources as any[],
        settings: {
          autoMemoryEnabled: true,
          autoMemoryDirectory: `${getWorkspaceRoot()}/${AGENT_MEMORY_SUBDIR}`,
        },
        // Acabox's relay servers plus the user's connectors. Connector ids are
        // validated host-side against RESERVED_CONNECTOR_IDS, so a connector
        // cannot shadow a relay server here.
        mcpServers: { ...state.mcpRelayServers, ...state.mcpConnectors } as any,
        allowedTools: sessionConfig.allowedTools,
      },
    });

    state.queryInstance = queryInstance;

    let authRetryCount = 0;
    for await (const message of queryInstance) {
      broadcastSSE(state, 'message', message);

      const msg = message as any;
      if (msg.type === 'system' && msg.subtype === 'api_retry' && (msg.error_status === 401 || msg.error_status === 403)) {
        authRetryCount++;
        if (authRetryCount > 1) {
          console.log(`[AgentServer] Auth error persisted after retry (status=${msg.error_status}), aborting query`);
          queryInstance.close();
          throw new Error(`Failed to authenticate. API Error: ${msg.error_status}`);
        }
      }
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
        const configDir = getClaudeConfigDir();
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
  if (parts[0] === 'credentials') return { path: 'credentials' };
  if (parts[0] === 'connectors') {
    if (parts.length === 1) return { path: 'connectors' };
    if (parts.length === 2 && parts[1] === 'status') return { path: 'connectors-status' };
  }
  if (parts[0] === 'sessions') {
    if (parts.length === 1) return { path: 'sessions' };
    if (parts.length === 3) return { path: 'session-action', sessionId: parts[1], action: parts[2] };
  }
  return { path: 'unknown' };
}

/**
 * Push a new connector set into one live session.
 *
 * `setMcpServers` REPLACES the entire set of dynamically-added MCP servers,
 * and Acabox's relay servers (activity, mini-apps, workspace, notification,
 * reaction) were themselves added dynamically via the `mcpServers` option —
 * so sending only the connectors silently disconnects the relays and the
 * agent loses the ability to open mini-apps or query the workspace. Measured:
 * `setMcpServers({hex})` against a session holding a relay returned
 * `{added:['hex'], removed:['relaydemo']}`.
 *
 * Always send both halves. That is the whole reason this function exists;
 * do not call `setMcpServers` directly anywhere else.
 */
async function applyConnectorsToSession(
  state: SessionState,
  connectors: Record<string, Record<string, unknown>>,
): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> } | null> {
  const previous = Object.keys(state.mcpConnectors);
  state.mcpConnectors = connectors;

  // No live query (session created but idle, or between turns after a close):
  // the next startQuery() reads state.mcpConnectors, so we're already done.
  const q = state.queryInstance;
  if (!q || typeof (q as any).setMcpServers !== 'function') return null;

  const result = await (q as any).setMcpServers({
    ...state.mcpRelayServers,
    ...state.mcpConnectors,
  });

  // setMcpServers does not always drop a server it wasn't given. Measured
  // against the bundled SDK: a server supplied in the original `mcpServers`
  // option that never got past `needs-auth` survives `setMcpServers({})` with
  // `removed: []` and stays in mcpServerStatus(). (One that was itself ADDED
  // by a previous setMcpServers call removes cleanly, as does a connected
  // one — it is specifically the option-passed, never-connected case.)
  //
  // `toggleMcpServer(name, false)` does move it to `disabled`, so use that as
  // the backstop, and only for names WE previously supplied — never a relay
  // server, and never a `.mcp.json` server the user set up themselves.
  const stillExpected = new Set(Object.keys(connectors));
  const dropped = previous.filter((name) => !stillExpected.has(name) && !(name in state.mcpRelayServers));
  if (dropped.length && typeof (q as any).toggleMcpServer === 'function') {
    let present: Set<string>;
    try {
      const status = await (q as any).mcpServerStatus();
      present = new Set((status ?? []).map((s: any) => s?.name));
    } catch {
      present = new Set(dropped); // can't tell — try them all
    }
    for (const name of dropped) {
      if (!present.has(name)) continue;
      try {
        await (q as any).toggleMcpServer(name, false);
        result.removed = [...(result.removed ?? []), name];
        console.log(`[AgentServer] Force-disabled lingering connector "${name}" on ${state.sessionId}`);
      } catch (err) {
        console.warn(`[AgentServer] Could not disable "${name}" on ${state.sessionId}:`, err);
      }
    }
  }

  console.log(
    `[AgentServer] Connectors applied to ${state.sessionId}: `
    + `added=[${result?.added ?? []}] removed=[${result?.removed ?? []}] `
    + `errors=${JSON.stringify(result?.errors ?? {})}`,
  );
  return result;
}

function startServer(initialConfig: AgentConfig): void {
  let currentConfig = initialConfig;

  const server = createServer(async (req, res) => {
    const route = parseRoute(req.url ?? '/');

    try {
      if (route.path === 'health' && req.method === 'GET') {
        // `instance` and `workspace` let the host tell ITS agent server apart
        // from another Acabox install's on the shared 23200-23299 range.
        // Without this a dev instance happily adopts the packaged app's
        // server and drives the wrong workspace with the wrong API key.
        sendJSON(res, 200, {
          status: 'ok',
          sessions: sessions.size,
          instance: process.env.COSCIENTIST_AGENT_INSTANCE ?? null,
          workspace: getWorkspaceRoot(),
        });
        return;
      }

      if (route.path === 'credentials' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (body.anthropicApiKey) {
          currentConfig = { ...currentConfig, anthropicApiKey: body.anthropicApiKey };
        }
        if ('anthropicBaseURL' in body) {
          currentConfig = { ...currentConfig, anthropicBaseURL: body.anthropicBaseURL || undefined };
        }
        console.log('[AgentServer] Credentials updated');
        sendJSON(res, 200, { ok: true });
        return;
      }

      // Replace the user's connector set. Applies to every live session
      // immediately (no new chat needed) and becomes the default for sessions
      // created afterwards.
      if (route.path === 'connectors' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const connectors = (body.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
        // `mcpServers` and `allowedTools` must move together — see
        // replaceConnectorAllowedTools. Leaving the tool list frozen at its
        // boot value meant a connector added later was never auto-approved.
        //
        // Read the outgoing set into a local FIRST. Inlining
        // `Object.keys(currentConfig.mcpServers)` into the object literal below
        // does happen to work (the literal is fully evaluated before the
        // assignment lands), but it reads as a use-after-overwrite and is one
        // careless refactor away from actually becoming one.
        const priorConnectorIds = Object.keys(currentConfig.mcpServers ?? {});
        currentConfig = {
          ...currentConfig,
          mcpServers: connectors,
          allowedTools: replaceConnectorAllowedTools(
            currentConfig.allowedTools ?? [],
            priorConnectorIds,
            Object.keys(connectors),
          ),
        };

        const applied: Array<{ sessionId: string; added: string[]; removed: string[]; errors: Record<string, string> }> = [];
        for (const [sessionId, state] of sessions) {
          try {
            const result = await applyConnectorsToSession(state, connectors);
            if (result) applied.push({ sessionId, ...result });
          } catch (err) {
            // One wedged session must not block the rest, and the config
            // update above already stands for future sessions.
            console.error(`[AgentServer] Failed to apply connectors to ${sessionId}:`, err);
          }
        }
        // Log the auto-approve half too. It used to be silently frozen at its
        // boot value while `mcpServers` moved, and nothing anywhere surfaced
        // the divergence — this line is what makes the two visibly agree.
        console.log(
          `[AgentServer] Connectors updated: [${Object.keys(connectors).join(', ')}] `
          + `across ${applied.length} live session(s); `
          + `auto-approve=[${(currentConfig.allowedTools ?? []).filter((t) => t.startsWith('mcp__') && !t.slice(5).includes('__')).join(', ')}]`,
        );
        sendJSON(res, 200, { ok: true, applied });
        return;
      }

      // Real connection status straight from the SDK. Reported per live
      // session; with none running there is nothing observed to report and
      // the caller renders "unknown" rather than inventing a state.
      if (route.path === 'connectors-status' && req.method === 'GET') {
        for (const state of sessions.values()) {
          const q = state.queryInstance as any;
          if (!q || typeof q.mcpServerStatus !== 'function') continue;
          try {
            const servers = await q.mcpServerStatus();
            sendJSON(res, 200, { live: true, sessionId: state.sessionId, servers });
            return;
          } catch (err) {
            console.warn(`[AgentServer] mcpServerStatus failed for ${state.sessionId}:`, err);
          }
        }
        sendJSON(res, 200, { live: false, servers: [] });
        return;
      }

      if (route.path === 'sessions' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const sessionId = body.sessionId ?? randomUUID();
        const resumeSessionId = body.resumeSessionId;
        const sessionOverrides: SessionOverrides = {
          additionalAllowedTools: body.additionalAllowedTools,
          soulMd: body.soulMd,
          hostGuidance: body.hostGuidance,
          workspaceDirectoriesGuidance: body.workspaceDirectoriesGuidance,
          model: body.model,
          effort: body.effort,
        };
        createSession(sessionId, currentConfig, resumeSessionId, sessionOverrides);
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

  const port = process.env.COSCIENTIST_AGENT_PORT
    ? parseInt(process.env.COSCIENTIST_AGENT_PORT, 10)
    : currentConfig.port;
  server.listen(port, '127.0.0.1', () => {
    console.log(`[AgentServer] Listening on 127.0.0.1:${port}`);
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
// (which handles session load/resume) uses the same persistent directory.
// The subprocess also receives it via the query() env option.
process.env.CLAUDE_CONFIG_DIR = getClaudeConfigDir();

startServer(loadConfig());
