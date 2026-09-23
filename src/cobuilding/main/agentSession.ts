
import { type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatStreamMessage, IPCAttachment, Workspace, NotificationNavigationAction } from '../shared/types';
import { createSession, setSdkSessionId, clearSdkSessionId, setSessionModelInfo, setSessionAppDirName, insertMessage, cleanupOrphanTurnRows, getSession, getSessionActivity } from './db/chatRepository';
import { listWorkspaceDirectories } from './db/workspaceRepository';
import * as fs from 'fs';
import path from 'path';
import log from 'electron-log';
import { captureError } from '../shared/telemetry';
import { composeQuotedText, type AcaboxQuote } from '../shared/quotes';
import { composeChatRefsText } from '../shared/chatLinks';
import { resolveChatRefs } from './chatRefResolver';
import { containerService } from './containerService';
import * as mcpHost from './mcpHost';
import { commandLogger, parseAppDirFromArgs } from './commandLogger';
import http from 'http';
import { type HostApp } from './hostApps';
import { IDENTITY_PREAMBLE } from './hostApps/identityPreamble';
import { ACADEMIA_DIR, SOUL_MD } from '../shared/paths';
import { recordConnectorStatus } from './connectorsStore';
import { buildApiGuidance } from '../shared/apis';
import { listApisWithSecrets } from './apiStore';
import { apiProxy } from './apiProxy';
import { noteFindingsFileRead } from './knowledge/findingsLedger';
import { noteTurn } from './knowledge/omissionWatch';
import { noteTurnEnded, noteTurnStarted } from './chatActivity';
import { extractScaffoldedDirName, extractOpenedDirName } from './appChatLink';

class AuthRetryError extends Error {
  constructor(public originalError: string) {
    super(`Auth retry: ${originalError}`);
  }
}

function isAuthError(msg: string): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return lower.includes('401') && (lower.includes('authenticat') || lower.includes('token') || lower.includes('unauthorized'));
}

/**
 * A context-window rejection arrives as a `result` message with `is_error` set
 * and the API's own wording as the result text — the SDK still reports
 * `subtype: 'success'`, so the flag plus the text is the whole signal.
 *
 * The text has to be matched as well as the flag: an ordinary failed turn also
 * sets `is_error`, and resetting the agent's memory of the conversation is far
 * too destructive a response to a tool that happened to throw.
 */
export function isContextOverflowResult(message: SDKMessage): boolean {
  const msg = message as any;
  if (msg?.type !== 'result' || !msg.is_error) return false;
  const text = typeof msg.result === 'string' ? msg.result : '';
  return /prompt is too long|context (window|length) exceeded|too many (input )?tokens/i.test(text);
}

/**
 * Shown once, in place of a bare "Prompt is too long", when a thread's history
 * has outgrown the context window. Third person and impersonal to match the
 * other host-authored refusals — the model did not write this, and did not see
 * the turn that produced it. It states the loss (the agent's memory of the
 * chat) plainly rather than letting the reset look like nothing happened.
 */
/** Mutable per-session turn state, shared by reference with the SSE reader. */
interface TurnState {
  /** Set by sendMessage so the SSE reader can stamp it on turn-complete for
   *  renderer correlation. Null for callers that supply none (overlay,
   *  scheduled tasks). */
  currentMessageId: string | null;
  /** Set by sendMessage, cleared on 'result'. Distinct from the
   *  session-lifetime `running` flag; read by the registry to decide
   *  destroy-now vs defer-until-turn-end. */
  turnInProgress: boolean;
  /** Set once this session's transcript has been rejected as too long, so the
   *  loop stops resuming it. See the declaration site for why the DB column
   *  alone is not sufficient. */
  resumeDisabled: boolean;
  /** Tool names used this turn, for the knowledge omission rule. Reset per turn. */
  toolNames: string[];
  /** Paths passed to Read this turn. The omission rule is unfalsifiable
   *  without them — every connector turn would raise a row. Reset per turn. */
  readPaths: string[];
  /** Evidence for `isSwallowedResumeTurn`, reset per turn: how many
   *  `assistant` messages and streamed deltas the stream carried (zero of both
   *  means the model was never consulted) and how many background tasks the
   *  CLI reported `stopped`. */
  assistantMessages: number;
  streamEvents: number;
  stoppedTaskNotifications: number;
  /** The swallowed-result ladder (`swallowedResultAction`): set when the host
   *  first kept the turn open past an empty result, and when it then re-sent
   *  the message. Each step happens at most once per turn; sendMessage resets
   *  both, because a new message is a new chance. */
  waitedForFollowUp: boolean;
  redelivered: boolean;
  /** Armed while waiting for the CLI's follow-up turn; see armFollowUpWatchdog. */
  swallowWatchdog: NodeJS.Timeout | null;
}

const CONTEXT_OVERFLOW_MESSAGE =
  "This conversation is too long for the model's context window, so the request was " +
  'rejected before the model saw it. Its history has been reset — the next message will ' +
  'start from a clean context, without the earlier turns in this chat.';

/**
 * A result that is NOT the end of the user's turn — the one case this file
 * declines to complete a turn on `result`.
 *
 * Observed eight times in production between 2026-09-17 and 09-21, always the
 * first message after a gap, in a chat whose previous turn had started a
 * background shell command. Acabox tears the CLI subprocess down between
 * turns, which orphans the command; on the next resume the CLI queues ITSELF a
 * `<task-notification>` about it and dequeues that as a turn's prompt, 9–18 ms
 * before the user's text reaches the queue. That turn makes no API call and
 * ends
 *
 *     {"subtype":"success","result":"","is_error":false}
 *
 * The CLI then dequeues the user's text and starts a turn for it on its own —
 * measured on dev and production alike, that turn's `init` arrives ~10 ms
 * after the empty result. The host was treating the empty result as
 * turn-complete, and the registry then destroyed the session (`/stop` →
 * `query.close()` → SIGTERM) 28 ms into the user's real turn. The renderer,
 * correctly, hid the thinking indicator with nothing under it. Retyping
 * started a fresh session and worked every time; the fix is to recognise this
 * result and simply not end the turn on it.
 *
 * All three conditions are load-bearing. An empty success alone is legitimate
 * — `/compact` ends that way, and it is a real API call that must not be
 * repeated. No assistant message and no streamed delta is what proves the
 * model was never called. And the `stopped` notification is the cause, not a
 * coincidence: without it this predicate stays out of the way of anything
 * else that can end a turn empty.
 */
export function isSwallowedResumeTurn(
  message: SDKMessage,
  turn: Pick<TurnState, 'assistantMessages' | 'streamEvents' | 'stoppedTaskNotifications'>,
): boolean {
  const msg = message as any;
  if (msg?.type !== 'result' || msg.subtype !== 'success' || msg.is_error) return false;
  if (typeof msg.result === 'string' && msg.result.trim() !== '') return false;
  if (turn.assistantMessages > 0 || turn.streamEvents > 0) return false;
  return turn.stoppedTaskNotifications > 0;
}

/**
 * Accumulate the two signals `isSwallowedResumeTurn` reads. Runs for every
 * message on the stream and is deliberately blind to everything else. Only a
 * `stopped` task counts: one that `completed` or `failed` on its own is the
 * ordinary background-task lifecycle and says nothing about a swallowed turn.
 */
export function noteSwallowSignals(
  message: SDKMessage,
  turn: Pick<TurnState, 'assistantMessages' | 'streamEvents' | 'stoppedTaskNotifications'>,
): void {
  const msg = message as any;
  if (msg?.type === 'assistant') {
    turn.assistantMessages++;
  } else if (msg?.type === 'stream_event') {
    turn.streamEvents++;
  } else if (msg?.type === 'system' && msg.subtype === 'task_notification' && msg.status === 'stopped') {
    turn.stoppedTaskNotifications++;
  }
}

/**
 * What to do with a result `isSwallowedResumeTurn` matched. Pure, so the
 * three-step ladder is testable without a session.
 *
 *   wait      — first time: keep the turn open. The CLI is about to run the
 *               user's text itself, so this costs nothing.
 *   redeliver — the follow-up never showed a sign of life, or ended empty as
 *               well: re-send the message once (one extra API call).
 *   surface   — the redelivery ended empty too: tell the user, complete.
 */
export type SwallowedResultAction = 'wait' | 'redeliver' | 'surface';
export function swallowedResultAction(
  turn: Pick<TurnState, 'waitedForFollowUp' | 'redelivered'>,
): SwallowedResultAction {
  if (!turn.waitedForFollowUp) return 'wait';
  if (!turn.redelivered) return 'redeliver';
  return 'surface';
}

/**
 * How long the host gives the CLI's follow-up turn to show a first sign of
 * life before falling back to redelivery. Its `init` arrives in ~10 ms and,
 * with `includePartialMessages` on, the first streamed event as soon as the
 * API answers — so 15 s of silence means it is not coming, not that it is slow.
 */
const SWALLOW_FOLLOW_UP_WAIT_MS = 15_000;

/**
 * Shown when the redelivery ALSO came back empty — the last path on which
 * silence would otherwise be the whole answer. Same voice as the overflow
 * message: host-authored, third person, says what happened and what to do.
 */
const SWALLOWED_TURN_MESSAGE =
  'The agent did not answer that message. Its turn was spent on a background command left ' +
  'over from the previous session, and a second attempt came back empty as well. Send it again.';

export function resolveSessionHostApp(_documentPath: string | null | undefined): { hostApp: HostApp | null; matched: boolean } {
  return { hostApp: null, matched: false };
}

// ─── MCP Relay Dispatch ──────────────────────────────────────────
// Maps MCP tool calls from the in-container agent to host-side MCP server handlers.
// The host MCP servers are stored on globalThis by AgentInfrastructureController.

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * `mcpHost.invoke()` resolves to the MCP SDK's own `CallToolResult`
 * (`{content: ContentBlock[], isError?}`), which is a different shape from
 * this module's `ToolResult` — text-only content, `isError` always present.
 * A hosted server is free to return a non-text block (an image, an embedded
 * resource); `ToolResult.content` cannot carry one, so each block is
 * converted deliberately rather than assumed to be `{type:'text',text}` —
 * that assumption (`content[0].text`) is exactly what would throw on the
 * first non-text block a hosted server ever returned.
 */
/**
 * Increment 7's write gate, Layer 2 — the actual boundary (design:
 * `docs/design/mcp-hosting.md`, the DECISION (2026-08-13) block superseding
 * R15). Written to match the shipped API-proxy's refusal style
 * (`apiProxy.ts`'s `performApiRequest`, step 3: `""${api.id}" is read-only, so
 * ${method} is refused. Ask the user to enable writes for it in Settings →
 * APIs if this is intended."` — CLAUDE.md records the agent "quot[ed] the
 * actionable message verbatim" on that one) — names the server, names the
 * tool, and states the fix in the user's own vocabulary (the Servers page's
 * per-tool checkboxes), because this text is read by the MODEL, not logged
 * for a human.
 *
 * Deliberately built from ONLY `serverId` and `toolName` — both already known
 * to the caller from the tool-call arguments the model itself supplied, and
 * neither is a secret. This is what keeps the record's `env` and its resolved
 * `command`/`args` structurally unable to leak here: there is no code path in
 * this function that could reach them, rather than a discipline of simply not
 * mentioning them.
 */
function hostedToolRefusalMessage(serverId: string, toolName: string): string {
  return `"${toolName}" on hosted MCP server "${serverId}" is not enabled for Claude to call. `
    + `Ask the user to enable "${toolName}" for "${serverId}" on the Servers page.`;
}

function hostedResultToRelayResult(result: unknown): ToolResult {
  const r = (result && typeof result === 'object') ? (result as { content?: unknown; isError?: boolean }) : {};
  const blocks = Array.isArray(r.content) ? r.content : [];
  const content = blocks.map((block: unknown): { type: 'text'; text: string } => {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      return { type: 'text', text: (block as { text: string }).text };
    }
    const kind = (block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string')
      ? (block as { type: string }).type
      : 'unknown';
    return { type: 'text', text: `[${kind} content omitted — this relay only carries text]` };
  });
  return {
    content: content.length ? content : [{ type: 'text', text: '' }],
    isError: r.isError === true,
  };
}

export async function handleMcpRelay(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const mcpServers = (globalThis as any).__hostMcpServers as Record<string, any> | undefined;
  if (mcpServers?.[serverName]?.[toolName]) {
    try {
      return await mcpServers[serverName][toolName](args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `MCP call failed: ${msg}` }], isError: true };
    }
  }

  // Fall through to mini-app MCP registry — mini-apps publish servers
  // dynamically as their iframes mount.
  const { miniAppMcpRegistry } = await import('./miniAppMcpRegistry');
  if (miniAppMcpRegistry.hasServer(serverName)) {
    const { result, error } = await miniAppMcpRegistry.invoke(serverName, toolName, args);
    if (error) {
      return { content: [{ type: 'text', text: error }], isError: true };
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: 'text', text }] };
  }

  // Fall through to hosted MCP servers — Acabox's own supervised local stdio
  // processes that stay alive for the life of the app (docs/design/mcp-hosting.md,
  // Increment 4), rather than the CLI's superseded one-child-per-turn model.
  //
  // Checked by MEMBERSHIP first, not by calling invoke() and inspecting the
  // failure: `mcpHost.invoke()` throws the exact same "Server \"<id>\" is
  // stopped: cannot call …" message for an id it manages but has never
  // started as it does for an id it has never heard of at all — there is no
  // way to tell "not hosted, keep falling through to Unknown MCP server"
  // apart from "hosted but down, report the real error" from the exception
  // alone.
  //
  // Two membership checks, cheap one first, and the split is deliberate.
  //
  // `isHosted()` reads the supervisor's in-memory handle map, so it is free.
  // It answers true for every server that has been started at least once this
  // run — which covers the whole hot path, because a server only ever reaches
  // the CLI's relay by appearing in a `POST /hosted` payload, and only a READY
  // server does that.
  //
  // `list()` is the fallback, and it is not free: it reads the sealed store off
  // disk synchronously and `safeStorage`-decrypts it, on the main thread. Doing
  // that on every call would put a blocking decrypt inside a loop the model
  // controls. Doing it only here costs nothing in practice and buys the honest
  // error for a configured-but-never-started server — "this server is stopped"
  // rather than "Unknown MCP server", which would send the user hunting for a
  // typo in a name that is in fact perfectly correct.
  const hosted = mcpHost.isHosted(serverName)
    || (await mcpHost.list()).some((s) => s.id === serverName);
  if (hosted) {
    // Increment 7's write gate, Layer 2 — checked HERE, before
    // `mcpHost.invoke()`, because this is the only place that can refuse a
    // call with certainty. Layer 1 (`mcpHost.readyServersForAgent`'s filter
    // on the `POST /hosted` push) only keeps an unselected tool's schema out
    // of context; it cannot un-register a relay the CLI already holds from an
    // earlier, wider push, so a selection narrowed mid-session would
    // otherwise leave that tool callable until the next push happens to fire.
    // `mcpHost.isToolEnabled` reads the supervisor's live in-memory record —
    // no disk read, so this adds nothing to the hot-path decrypt count the
    // membership check above already goes out of its way to avoid.
    if (!mcpHost.isToolEnabled(serverName, toolName)) {
      return { content: [{ type: 'text', text: hostedToolRefusalMessage(serverName, toolName) }], isError: true };
    }
    try {
      const result = await mcpHost.invoke(serverName, toolName, args);
      return hostedResultToRelayResult(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `MCP call failed: ${msg}` }], isError: true };
    }
  }

  return { content: [{ type: 'text', text: `Unknown MCP server: ${serverName}` }], isError: true };
}



export interface ChatCallbacks {
  onEvent: (msg: ChatStreamMessage) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

/**
 * Fan a chat event out to every listener that was registered when the dispatch
 * began.
 *
 * **The snapshot is load-bearing, not defensive style.** Listeners tear each
 * other down: the session registry's listener handles `turn-complete` by
 * destroying the session, which runs the destroy hooks, which unregister the
 * renderer's event-forwarding listener. The registry registers first and the
 * forwarding pipe second, so iterating the live Set would delete the pipe
 * before the iteration reached it — a `Set` iterator skips an element removed
 * before it is visited. The renderer would then never receive the very
 * `turn-complete` that triggered the teardown, and its run would hang until the
 * stall watchdog fired 45s later. That was a real bug (B14).
 *
 * `emitDone` has always snapshotted for the same reason. Exported so tests can
 * exercise the real dispatch semantics instead of a hand-rolled mock that
 * silently disagrees with it — which is exactly how B14 shipped green.
 */
export function dispatchChatEvent(
  listeners: Iterable<Partial<ChatCallbacks>>,
  msg: ChatStreamMessage,
): void {
  for (const listener of [...listeners]) {
    listener.onEvent?.(msg);
  }
}

export interface AgentSession {
  // `messageId` is a renderer-generated UUID that correlates a turn end-to-end.
  // Optional so internal callers (scheduled tasks, calendar) that don't model
  // turns this way can omit it.
  sendMessage(userMessage: string, attachments?: IPCAttachment[], messageId?: string, quote?: AcaboxQuote): void;
  destroy(): void;
  addListener(callbacks: Partial<ChatCallbacks>): () => void;
  /** True while the session loop is alive — does NOT track per-turn busy state. */
  readonly isRunning: boolean;
  /** True iff the agent is currently processing a user turn (between user
   *  message dispatch and the result event). The registry consults this when
   *  the last subscriber detaches: if false, destroy now; if true, defer
   *  until the turn-complete event lands. */
  readonly isTurnInProgress: boolean;
}

export function createAgentSession(
  sessionId: string,
  callbacks: ChatCallbacks,
  workspace: Workspace,
  sdkSessionId?: string,
  source?: string,
  onNotificationClick?: (action: NotificationNavigationAction | null) => void,
  model?: string,
  messagePreprocessor?: (text: string) => string,
  documentPath?: string,
  refreshAndPushCredentials?: () => Promise<boolean>,
  effort?: string,
): AgentSession {
  const listeners = new Set<Partial<ChatCallbacks>>();
  let running = true;
  let agentSessionId: string | null = null;
  let sseRequest: http.ClientRequest | null = null;
  const pendingMessages: Array<{ text: string; attachments?: IPCAttachment[]; messageId?: string }> = [];
  let inflightMessage: { text: string; attachments?: IPCAttachment[]; messageId?: string } | null = null;
  // Shared with connectSSE (module-scope) by reference.
  //   currentMessageId — set by sendMessage so the SSE reader can stamp it
  //     on turn-complete for renderer correlation. May be null (overlay,
  //     scheduled tasks don't supply one).
  //   turnInProgress — set by sendMessage, cleared on 'result'. Distinct
  //     from the session-lifetime `running` flag; read by the registry to
  //     decide destroy-now vs defer-until-turn-end.
  //   resumeDisabled — set when a turn is rejected for exceeding the context
  //     window. The resumed transcript is the thing that no longer fits, so it
  //     must not be resumed again. Clearing the DB column alone is not enough:
  //     startLoop falls back to the constructor-time `sdkSessionId` when the
  //     column is null, which would resurrect the poisoned id if the loop
  //     restarts inside this same session object (a second message sent before
  //     the registry destroys it, a 404 re-queue, an auth retry).
  const turnState: TurnState = {
    currentMessageId: null,
    turnInProgress: false,
    resumeDisabled: false,
    toolNames: [],
    readPaths: [],
    assistantMessages: 0,
    streamEvents: 0,
    stoppedTaskNotifications: 0,
    waitedForFollowUp: false,
    redelivered: false,
    swallowWatchdog: null,
  };
  // Cursor into the agent-server's per-session event sequence. Updated as we
  // parse `id:` lines from the SSE stream. On reconnect we send this as the
  // `Last-Event-Id` header so the server resumes from the next event.
  const sseCursor: { lastEventId: number | null } = { lastEventId: null };
  const sessionState = { stopped: false }; // object so connectSSE sees mutations by reference

  // Register the initial callbacks as the first listener
  listeners.add(callbacks);

  function emitEvent(msg: ChatStreamMessage) {
    if (msg.type !== 'heartbeat') {
      running = true;
    }
    dispatchChatEvent(listeners, msg);
  }

  const HEARTBEAT_INTERVAL_MS = 15_000;
  const heartbeatTimer = setInterval(() => {
    if (running) {
      emitEvent({ type: 'heartbeat' });
    }
  }, HEARTBEAT_INTERVAL_MS);

  function emitDone() {
    if (!running) return; // idempotent — only fire onDone once per session turn
    running = false;
    for (const listener of [...listeners]) {
      listener.onDone?.();
    }
  }

  function emitError(error: string) {
    running = false;
    clearInterval(heartbeatTimer);
    // An error ends the turn as far as anyone watching is concerned, though
    // `turnInProgress` is left alone (the registry's deferred-destroy logic
    // reads it). Without this the chat would pulse "working" until destroyed.
    noteTurnEnded(sessionId);
    for (const listener of [...listeners]) {
      listener.onError?.(error);
    }
  }

  createSession(sessionId, workspace.id, source ?? null, documentPath ?? null);

  // Resuming or starting fresh on a session that crashed mid-turn leaves
  // orphan `assistant` / `tool_result` rows after the last `result` row;
  // without this sweep the renderer shows a forever-spinning tool-use.
  const orphansRemoved = cleanupOrphanTurnRows(sessionId);
  if (orphansRemoved > 0) {
    log.info(`[AgentSession] Cleaned ${orphansRemoved} orphan turn rows for sessionId=${sessionId}`);
  }

  // Resolve which host app this session is acting on. See resolveSessionHostApp
  // for the resolution order — document path first, focused-window bundle id
  // as a backstop, then Word fallback.
  const { hostApp: sessionHostApp, matched: hostAppMatched } = resolveSessionHostApp(documentPath);

  const state: MessageProcessingState = {
    currentToolCallId: null,
    currentBlockIsThinking: false,
    pendingBashCalls: new Map(),
    onAppLink: (dirName, via) => {
      try {
        const linked = setSessionAppDirName(sessionId, dirName);
        if (linked) {
          log.info(`[AppChatLinks] Linked chat ${sessionId} to ${dirName} (via ${via})`);
        }
      } catch (err) {
        log.warn(`[AppChatLinks] Failed to link chat ${sessionId} to ${dirName}: ${(err as Error).message}`);
      }
    },
  };

  // ─── Agent Server Communication ───────────────────────────────

  // Wait for the agent server to be ready before connecting. Emits status
  // updates so the spinner shows what we're blocked on:
  //   "Starting agent service..." — host-process service hasn't reported ready
  //   "Waiting for agent..."      — service is up but the agent HTTP isn't responding yet
  async function waitForAgent(): Promise<string> {
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();
    let anyStatusEmitted = false;
    while (!sessionState.stopped) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        throw new Error('Agent failed to start. Check the Debug panel for details.');
      }
      const isRunning = containerService.isRunning();
      const port = containerService.getAgentPort();

      let status = '';
      if (!isRunning) {
        status = 'Starting agent service...';
      } else if (!port) {
        status = 'Waiting for agent...';
      }

      if (port && isRunning) {
        try {
          const res = await httpGet(`http://localhost:${port}/health`);
          if (res.includes('"ok"')) {
            if (anyStatusEmitted) {
              emitEvent({ type: 'status', status: '' } as ChatStreamMessage);
            }
            return `http://localhost:${port}`;
          }
        } catch {
          // Agent server not responding yet
        }
        status = 'Waiting for agent...';
      }

      // Emit status on every iteration — the forwarding listener may not be
      // attached on the first iteration (race between session creation and
      // IPC forwarding setup), so we keep re-emitting until the agent is ready.
      if (status) {
        emitEvent({ type: 'status', status } as ChatStreamMessage);
        anyStatusEmitted = true;
      }

      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Session stopped while waiting for agent');
  }

  let agentBaseUrl: string;

  // Read SOUL.md
  let soulMdContent: string | undefined;
  try {
    const soulPath = path.join(workspace.directory_path, ACADEMIA_DIR, SOUL_MD);
    const content = fs.readFileSync(soulPath, 'utf-8').trim();
    if (content) soulMdContent = content;
  } catch { /* doesn't exist */ }

  const hostGuidance = (hostAppMatched && sessionHostApp)
    ? [IDENTITY_PREAMBLE, sessionHostApp.systemPromptAppend].filter(Boolean).join('\n\n')
    : IDENTITY_PREAMBLE;

  // Build workspace directories guidance. Each user-shared directory is
  // symlinked into the workspace root (e.g. ${workspace}/MyResearch), so the
  // agent — whose cwd is the workspace — addresses them with simple relative
  // paths.
  let workspaceDirectoriesGuidance: string | undefined;
  try {
    const dirs = listWorkspaceDirectories(workspace.id);
    if (dirs.length > 0) {
      const lines = dirs.map(dir => {
        const name = path.basename(dir.directory_path);
        return dir.read_only
          ? `- ${name}/ (read only) — make a copy inside the workspace before editing; direct edits will fail.`
          : `- ${name}/ (read & write) — edit files directly.`;
      });
      workspaceDirectoriesGuidance = [
        '## Workspace Directories',
        'The following user research directories are available as subdirectories of your workspace:',
        ...lines,
      ].join('\n');
    }
  } catch { /* workspace may not have directories yet */ }

  // Non-null while the create-session + SSE-listen loop is running. Drops
  // back to null when the loop ends (idle eviction, /stop). The next
  // sendMessage observes the null and re-runs the loop with resume.
  let loopPromise: Promise<void> | null = null;

  /**
   * Finish a turn from the host side with a host-authored line. Used only when
   * a redelivery could not even be sent; the ordinary completion lives in the
   * SSE reader's result branch. The result row is required, not decorative:
   * `cleanupOrphanTurnRows` sweeps assistant rows that sit after the last
   * result at boot, so without it the explanation would vanish on relaunch.
   */
  const completeTurnFromHost = (text: string) => {
    const messageId = turnState.currentMessageId ?? undefined;
    insertMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text }]), messageId);
    emitEvent({ type: 'text', text });
    insertMessage(sessionId, 'result', JSON.stringify({ subtype: 'success', result: '', is_error: false }), messageId);
    turnState.turnInProgress = false;
    noteTurnEnded(sessionId);
    emitEvent({ type: 'turn-complete', messageId } as ChatStreamMessage);
    turnState.currentMessageId = null;
  };

  /**
   * Re-send the in-flight message into the live agent session, once.
   *
   * Same session, same CLI process, same text and messageId — so the assistant
   * rows and the eventual turn-complete correlate to the bubble the user is
   * already looking at. Nothing is inserted or emitted for the user side: the
   * row and the user-message event went out on the first attempt, and a second
   * bubble would misreport what the user did. Fire-and-forget like the
   * pending-message flush, because the SSE reader must not block on it.
   *
   * `stoppedTaskNotifications` is deliberately NOT reset here: it is what lets
   * an empty result from the redelivery still read as swallowed, so the ladder
   * can reach 'surface' instead of ending the turn silently.
   *
   * Returns false when there is nothing to re-send or this turn has had its
   * retry, and the caller then completes the turn as it normally would.
   */
  const redeliverSwallowedTurn = (): boolean => {
    const message = inflightMessage;
    if (!message || !agentSessionId || sessionState.stopped || turnState.redelivered) return false;
    turnState.redelivered = true;
    turnState.assistantMessages = 0;
    turnState.streamEvents = 0;
    log.info(
      `[AgentSession] Redelivering messageId=${message.messageId ?? '(none)'} to ${agentSessionId} ` +
      '— the CLI did not run the swallowed message itself',
    );
    httpPostWithStatus(
      `${agentBaseUrl}/sessions/${agentSessionId}/messages`,
      JSON.stringify({ text: message.text, attachments: message.attachments, messageId: message.messageId }),
    ).then(({ status, body }) => {
      if (status >= 400) throw new Error(`HTTP ${status} ${body}`);
    }).catch((err) => {
      // The retry never left. Say so and end the turn, or the indicator spins
      // against a message the agent will never receive.
      log.error('[AgentSession] Redelivery POST failed; completing the turn from the host:', err);
      if (turnState.turnInProgress) completeTurnFromHost(SWALLOWED_TURN_MESSAGE);
    });
    return true;
  };

  const clearFollowUpWatchdog = () => {
    if (turnState.swallowWatchdog) {
      clearTimeout(turnState.swallowWatchdog);
      turnState.swallowWatchdog = null;
    }
  };

  /**
   * If the CLI's follow-up turn has shown no sign of life by the deadline —
   * no streamed delta, no assistant message — fall back to re-sending. Deltas
   * count because `includePartialMessages` is on: `message_start` lands as
   * soon as the API answers, long before a thinking-heavy first block would.
   */
  const armFollowUpWatchdog = () => {
    clearFollowUpWatchdog();
    turnState.swallowWatchdog = setTimeout(() => {
      turnState.swallowWatchdog = null;
      if (!turnState.turnInProgress || sessionState.stopped) return;
      if (turnState.assistantMessages > 0 || turnState.streamEvents > 0) return;
      log.warn(`[AgentSession] No follow-up from the CLI ${SWALLOW_FOLLOW_UP_WAIT_MS}ms after the swallowed result — redelivering`);
      if (!redeliverSwallowedTurn()) completeTurnFromHost(SWALLOWED_TURN_MESSAGE);
    }, SWALLOW_FOLLOW_UP_WAIT_MS);
  };

  /**
   * The SSE reader saw a result `isSwallowedResumeTurn` matched. Apply the
   * ladder (`swallowedResultAction` is the rule; this is the plumbing) and
   * return true when the result has been absorbed and the turn must stay open.
   * False means complete the turn — after the caller has surfaced the fallback
   * text, if this was the 'surface' step.
   */
  const handleSwallowedResult = (): boolean => {
    const action = swallowedResultAction(turnState);
    if (action === 'wait') {
      turnState.waitedForFollowUp = true;
      log.info(
        `[AgentSession] Empty result after the CLI's own task notification — keeping the turn open ` +
        `for its follow-up (messageId=${turnState.currentMessageId ?? '(none)'})`,
      );
      armFollowUpWatchdog();
      return true;
    }
    clearFollowUpWatchdog();
    if (action === 'redeliver') return redeliverSwallowedTurn();
    return false;
  };

  function startLoop(): Promise<void> {
    if (loopPromise) return loopPromise;
    if (sessionState.stopped) return Promise.resolve();
    loopPromise = (async () => {
      let shouldRestartForAuth = false;
      let authRetried = false;
      try {
        agentBaseUrl = await waitForAgent();

        // Always re-read sdk_session_id from the DB at start. After the
        // first turn the agent advances its conversation id and we persist
        // it via setSdkSessionId; on a post-eviction restart we want to
        // resume from the latest, not the one captured when this
        // AgentSession object was constructed.
        const dbSession = getSession(sessionId);
        const resumeId = turnState.resumeDisabled
          ? undefined
          : (dbSession?.sdk_session_id ?? sdkSessionId);

        // Configured APIs (Settings → APIs). Read HERE rather than at session
        // construction — unlike the workspace-directory guidance above — so a
        // restart after an idle eviction picks up anything added since. It is
        // still only as fresh as the session, which is the known cost recorded
        // in the design; `mcp__apis__list_apis` reads live state for an agent
        // that thinks to ask.
        //
        // Skipped entirely when the proxy is down, so the agent is never told
        // to curl a base URL that does not exist.
        const apiGuidance = apiProxy.isRunning()
          ? buildApiGuidance(listApisWithSecrets())
          : undefined;

        // Sessions are persisted via a custom sessionStore that writes
        // JSONL files to /data/.academia/sessions/ on the workspace mount,
        // so resume restores the full conversation across restarts.
        const createBody = JSON.stringify({
          sessionId,
          resumeSessionId: resumeId,
          model: model || undefined,
          effort: effort || undefined,
          soulMd: soulMdContent,
          hostGuidance,
          workspaceDirectoriesGuidance,
          apiGuidance,
          ...((hostAppMatched && sessionHostApp) ? { additionalAllowedTools: sessionHostApp.allowedTools } : {}),
        });

        const createRes = await httpPost(`${agentBaseUrl}/sessions`, createBody);
        const createData = JSON.parse(createRes);
        agentSessionId = createData.sessionId;
        // Model/effort are logged because they are pinned per conversation and
        // reused across restarts — this line is how you confirm which one a
        // given turn actually ran on.
        log.info(
          `[AgentSession] Session created: ${agentSessionId} model=${model ?? '(default)'} ` +
          `effort=${effort ?? '(default)'}${resumeId ? ` (resumed from ${resumeId})` : ''}`,
        );

        // Reset the SSE cursor on (re)start. The agent-server's eventSeq
        // restarts from 0 for a fresh session, so a stale Last-Event-Id
        // from a prior loop would either skip every replayed event or be
        // silently ignored.
        sseCursor.lastEventId = null;

        // Flush any messages that arrived before the session was ready
        // (or were re-queued by a 404 from a now-evicted server session).
        const toFlush = pendingMessages.splice(0);
        for (const pending of toFlush) {
          inflightMessage = pending;
          httpPost(
            `${agentBaseUrl}/sessions/${agentSessionId}/messages`,
            JSON.stringify({ text: pending.text, attachments: pending.attachments, messageId: pending.messageId }),
          ).catch((err) => log.error('[AgentSession] Failed to send pending message:', err));
        }

        // Connect to SSE event stream. connectSSE resolves on a clean terminal
        // event ('done' or 'error') and rejects on transport failures
        // (TCP reset, ECONNREFUSED, etc.). Wrap it so transport rejections
        // trigger a bounded reconnect with `Last-Event-Id`, while clean
        // terminations exit immediately.
        const eventUrl = `${agentBaseUrl}/sessions/${agentSessionId}/events`;
        const RETRY_BACKOFFS_MS = [250, 500, 1000, 2000, 5000];
        for (let attempt = 0; ; attempt++) {
          try {
            await connectSSE(eventUrl, state, sessionId, emitEvent, emitDone, emitError, sessionState, (req) => {
              sseRequest = req;
            }, agentBaseUrl, agentSessionId!, turnState, sseCursor, !!refreshAndPushCredentials && !authRetried, handleSwallowedResult);
            break; // clean terminal event — done with this turn
          } catch (err) {
            if (err instanceof AuthRetryError && !authRetried && refreshAndPushCredentials) {
              authRetried = true;
              log.info(`[AgentSession] Auth error detected, attempting credential refresh: ${err.originalError}`);
              try {
                const refreshed = await refreshAndPushCredentials();
                if (refreshed) {
                  log.info('[AgentSession] Credentials refreshed, restarting session loop');
                  if (inflightMessage) {
                    pendingMessages.push(inflightMessage);
                    inflightMessage = null;
                  }
                  shouldRestartForAuth = true;
                  return;
                }
              } catch (refreshErr) {
                log.error('[AgentSession] Credential refresh failed:', refreshErr);
              }
              // Re-read of the user's key still got rejected — it's wrong,
              // expired, or missing. Point them at Settings rather than surface
              // the raw SDK 401.
              emitError('Your Anthropic API key was rejected. Update it in Settings and try again.');
              return;
            }
            if (sessionState.stopped) break;
            if (attempt >= RETRY_BACKOFFS_MS.length) {
              const msg = err instanceof Error ? err.message : String(err);
              log.error(`[AgentSession] SSE failed to reconnect after ${RETRY_BACKOFFS_MS.length} attempts (lastEventId=${sseCursor.lastEventId}):`, msg);
              captureError(err, {
                subsystem: 'agent',
                extra: {
                  phase: 'sse_reconnect_exhausted',
                  last_event_id: sseCursor.lastEventId,
                  attempts: RETRY_BACKOFFS_MS.length,
                },
              });
              throw err;
            }
            const backoff = RETRY_BACKOFFS_MS[attempt];
            const errMsg = err instanceof Error ? err.message : String(err);
            log.warn(`[AgentSession] SSE disconnected (${errMsg}); reconnecting in ${backoff}ms (attempt ${attempt + 1}/${RETRY_BACKOFFS_MS.length}, lastEventId=${sseCursor.lastEventId})`);
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
      } catch (err: unknown) {
        if (sessionState.stopped) {
          emitDone();
        } else {
          const errorMessage = err instanceof Error ? err.message : String(err);
          emitError(errorMessage);
        }
      } finally {
        // Loop is no longer active. Clear agentSessionId so a stale id
        // doesn't get reused for a POST against the evicted session.
        agentSessionId = null;
        loopPromise = null;
        if (shouldRestartForAuth) {
          startLoop();
        } else {
          inflightMessage = null;
          if (running) {
            // The SSE stream didn't deliver a turn-complete result. If this
            // was a clean idle eviction the host has nothing to wait on, so
            // settle the listener side. (Renderer is free to send another
            // message; sendMessage will restart the loop.)
            emitDone();
          }
          // If messages landed during shutdown, kick another loop so they
          // don't sit pending forever. startLoop short-circuits if stopped.
          if (pendingMessages.length > 0) startLoop();
        }
      }
    })();
    return loopPromise;
  }

  startLoop();

  return {
    sendMessage(userMessage: string, attachments?: IPCAttachment[], messageId?: string, quote?: AcaboxQuote) {
      // Stamp the turn so the SSE reader's synthetic turn-complete event can
      // include the same messageId. Cleared when the turn completes.
      // Only update when a messageId is actually provided — callers without
      // one (overlay HTTP/WS, scheduled tasks) must not clobber an existing
      // turn's correlation. The result handler is responsible for clearing
      // back to null when its turn finishes.
      if (messageId) {
        turnState.currentMessageId = messageId;
      }

      const storedAttachments = attachments?.map((att) => {
        if (att.type === 'file_reference') {
          return { type: att.type, filePath: att.filePath, name: att.name };
        }
        return {
          type: att.type,
          mediaType: att.mediaType,
          name: att.name,
          title: att.type === 'document' ? att.title : undefined,
        };
      });
      // The row stores what the user TYPED, plus the quote as its own field.
      // What the agent receives is the composed form built a few lines below.
      // Those two deliberately differ, and storing the composed string instead
      // would make the bubble render the excerpt twice — once as its own block
      // and once inside the message text.
      insertMessage(
        sessionId,
        'user',
        JSON.stringify({ text: userMessage, attachments: storedAttachments, ...(quote ? { quote } : {}) }),
        messageId,
      );
      // Mark a turn as in flight. Cleared by the SSE reader on the next
      // 'result' message. The registry uses this to decide whether a
      // navigation-away triggers destroy-now or defer-until-turn-end.
      turnState.turnInProgress = true;
      noteTurnStarted(sessionId);
      // The omission rule is per-TURN ("this turn queried the warehouse and
      // read no findings file"), not per-session, so the accumulators reset
      // here rather than at session create.
      turnState.toolNames = [];
      turnState.readPaths = [];
      // Swallowed-turn evidence is per turn too, and a fresh message gets a
      // fresh run at the ladder.
      turnState.assistantMessages = 0;
      turnState.streamEvents = 0;
      turnState.stoppedTaskNotifications = 0;
      turnState.waitedForFollowUp = false;
      turnState.redelivered = false;
      if (turnState.swallowWatchdog) {
        clearTimeout(turnState.swallowWatchdog);
        turnState.swallowWatchdog = null;
      }
      // Broadcast the user message to every surface subscribed to this
      // session. Without this, a message typed in the overlay would land
      // in SQLite but the desktop chat (subscribing via IPC fanout) would
      // never see the user turn — only the assistant's streamed reply.
      log.info(`[AgentSession] emitting user-message sessionId=${sessionId} messageId=${messageId ?? '(none)'} textLen=${userMessage.length}`);
      emitEvent({ type: 'user-message', text: userMessage, messageId });

      // Compose the quote in exactly one place, on the way out. `composeQuotedText`
      // is a no-op when there is no quote, so the ordinary path is unchanged.
      const quotedText = composeQuotedText(quote, userMessage);

      // Any acabox://chat/<id> links in what the user typed get resolved into
      // a short reference block — title, activity, owning tool — appended for
      // the agent. The transcript itself never travels here; the agent pulls
      // what it needs via the `read_chat` tool. See shared/chatLinks.ts.
      const chatRefs = resolveChatRefs(userMessage, sessionId, workspace.id, { getSession, getActivity: getSessionActivity });
      if (chatRefs.length > 0) {
        log.info(`[ChatLinks] ${chatRefs.length} referenced chat(s) in messageId=${messageId ?? '(none)'}: ${chatRefs.map((r) => `${r.sessionId.slice(0, 8)}${r.exists ? '' : '(missing)'}`).join(', ')}`);
      }
      const withRefs = composeChatRefsText(quotedText, chatRefs);
      const processedText = messagePreprocessor ? messagePreprocessor(withRefs) : withRefs;

      // Rewrite file attachment paths so the agent sees them relative to the
      // workspace cwd. User-shared directories are symlinked into the
      // workspace, so a host path that lives inside one of those mounts can be
      // translated to a workspace-relative path via the symlink name.
      const userDirs = listWorkspaceDirectories(workspace.id);
      const translatedAttachments = attachments?.map((att) => {
        if (att.type !== 'file_reference' || !att.filePath) return att;
        const filePath = att.filePath;
        if (filePath.startsWith(workspace.directory_path + path.sep)) {
          return { ...att, filePath: filePath.slice(workspace.directory_path.length + 1) };
        }
        for (const dir of userDirs) {
          if (filePath === dir.directory_path) {
            return { ...att, filePath: path.basename(dir.directory_path) };
          }
          if (filePath.startsWith(dir.directory_path + path.sep)) {
            const name = path.basename(dir.directory_path);
            return { ...att, filePath: name + filePath.slice(dir.directory_path.length) };
          }
        }
        return att;
      });

      const restart = (reason: string) => {
        log.info(`[AgentSession] ${reason} — re-queueing message and restarting session loop`);
        pendingMessages.push({ text: processedText, attachments: translatedAttachments, messageId });
        startLoop();
      };

      if (agentSessionId && loopPromise) {
        inflightMessage = { text: processedText, attachments: translatedAttachments, messageId };
        const targetSessionId = agentSessionId;
        httpPostWithStatus(
          `${agentBaseUrl}/sessions/${targetSessionId}/messages`,
          JSON.stringify({ text: processedText, attachments: translatedAttachments, messageId }),
        ).then(({ status, body }) => {
          // 404 means the server evicted us between our check and the POST
          // landing. Re-queue and restart; resume from sdk_session_id
          // preserves context.
          if (status === 404) {
            restart(`message POST to ${targetSessionId} returned 404`);
          } else if (status >= 400) {
            log.error(`[AgentSession] Message POST failed: HTTP ${status} ${body}`);
          }
        }).catch((err) => log.error('[AgentSession] Failed to send message:', err));
      } else {
        log.debug('[AgentSession] Session not ready, queuing message and ensuring loop is running');
        pendingMessages.push({ text: processedText, attachments: translatedAttachments, messageId });
        startLoop();
      }
    },

    destroy() {
      sessionState.stopped = true;
      clearInterval(heartbeatTimer);
      // A session torn down mid-turn (quit, crash-restart, eviction) never
      // reaches its result row. No-op when no turn was running.
      noteTurnEnded(sessionId);
      if (turnState.swallowWatchdog) {
        clearTimeout(turnState.swallowWatchdog);
        turnState.swallowWatchdog = null;
      }
      if (sseRequest) {
        sseRequest.destroy();
        sseRequest = null;
      }
      if (agentSessionId) {
        httpPost(`${agentBaseUrl}/sessions/${agentSessionId}/stop`, '{}').catch(() => {});
      }
    },

    addListener(cb: Partial<ChatCallbacks>): () => void {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    get isRunning() {
      return running;
    },

    get isTurnInProgress() {
      return turnState.turnInProgress;
    },
  };
}

// ─── HTTP Helpers ───────────────────────────────────────────────

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      timeout: 3000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function httpPostWithStatus(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpPost(url: string, body: string): Promise<string> {
  return httpPostWithStatus(url, body).then((r) => r.body);
}

/**
 * Fire-and-forget retry wrapper for the mcp-result POST. `callId` is the
 * idempotency key — the agent-server's pendingMcpCalls map resolves at most
 * once for a given callId, so a duplicate POST after a transient failure is
 * safely absorbed.
 *
 * No await at the call site: the SSE parser must not block on this. Final
 * failure is logged; the agent's 120s pendingMcpCall timeout is the backstop.
 */
async function postMcpResultWithRetry(url: string, body: string, callId: string): Promise<void> {
  const BACKOFFS_MS = [250, 500, 1000];
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      await httpPost(url, body);
      if (attempt > 0) {
        log.info(`[AgentSession] mcp-result POST succeeded after ${attempt} retries (callId=${callId})`);
      }
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= BACKOFFS_MS.length) {
        log.error(`[AgentSession] mcp-result POST failed after ${BACKOFFS_MS.length} retries (callId=${callId}): ${msg}`);
        captureError(err, {
          subsystem: 'agent',
          extra: {
            phase: 'mcp_result_post_exhausted',
            call_id: callId,
            attempts: BACKOFFS_MS.length,
          },
        });
        return;
      }
      const backoff = BACKOFFS_MS[attempt];
      log.warn(`[AgentSession] mcp-result POST failed (callId=${callId}, ${msg}); retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/**
 * Pull the two signals the knowledge loop needs out of one assistant message's
 * content blocks, and bump `last_read` on any findings file the model read.
 *
 * The freshness bump happens HERE rather than at turn end because it is about
 * the read itself, and it has to fire even for a turn that ends in an error.
 * `noteFindingsFileRead` resolves symlinks itself, so the raw path as it
 * appeared in the stream is what to hand it — the model addresses the ledger
 * through `.claude/skills/<id>/…`, which is a symlink into the store.
 *
 * Every failure mode here is swallowed. This is bookkeeping hanging off the
 * message loop; it must never be able to break a turn.
 */
function collectKnowledgeSignals(content: unknown, turnState: TurnState): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
    turnState.toolNames.push(b.name);
    // Read is the only tool whose path argument is load-bearing for the rule.
    // Grep/Glob over the findings dir are not "consulting the ledger" — they
    // return matches, not the entries, and the model still has to Read one.
    if (b.name !== 'Read') continue;
    const filePath = b.input?.file_path;
    if (typeof filePath !== 'string' || !filePath) continue;
    turnState.readPaths.push(filePath);
    try {
      const bumped = noteFindingsFileRead(filePath);
      if (bumped.length) {
        log.debug(`[Knowledge] last_read bumped on ${bumped.length} finding(s) via ${filePath}`);
      }
    } catch (err) {
      log.warn(`[Knowledge] last_read bump failed for ${filePath}: ${(err as Error).message}`);
    }
  }
}

async function connectSSE(
  url: string,
  state: MessageProcessingState,
  sessionId: string,
  emitEvent: (msg: ChatStreamMessage) => void,
  emitDone: () => void,
  emitError: (error: string) => void,
  sessionState: { stopped: boolean },
  onRequest: (req: http.ClientRequest) => void,
  agentBaseUrl: string,
  agentSessionId: string,
  turnState: TurnState,
  sseCursor: { lastEventId: number | null },
  canRetryAuth?: boolean,
  onSwallowedResult?: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    // On reconnect, ask the agent-server to resume from the last id we saw.
    // First connection has no cursor and gets the full buffer (existing behavior).
    if (sseCursor.lastEventId !== null) {
      headers['Last-Event-Id'] = String(sseCursor.lastEventId);
    }
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      headers,
    }, (res) => {
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');

        // Parse SSE events from buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const lines = part.split('\n');
          let eventType = '';
          let data = '';
          let eventId: number | null = null;

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7);
            } else if (line.startsWith('data: ')) {
              data = line.slice(6);
            } else if (line.startsWith('id: ')) {
              const parsedId = Number.parseInt(line.slice(4), 10);
              if (Number.isFinite(parsedId)) eventId = parsedId;
            }
          }

          // Advance the cursor as soon as we've seen the id line, even if
          // the event handler below errors. That way a partial-event failure
          // still resumes from the right place on reconnect.
          if (eventId !== null) sseCursor.lastEventId = eventId;

          if (!eventType || !data) continue;

          if (eventType === 'message') {
            try {
              const message = JSON.parse(data) as SDKMessage;
              if (message.type !== 'stream_event') {
                // Subtype too: an eaten turn is only diagnosable from the log
                // if the `task_notification` that ate it is named in it.
                const subtype = (message as any).subtype;
                log.debug(`[AgentSession:SSE] message type=${message.type}${subtype ? ` subtype=${subtype}` : ''}`);
              }
              processQueryMessage(message, state, emitEvent);
              noteSwallowSignals(message, turnState);

              if (message.type === 'system') {
                setSdkSessionId(sessionId, (message as any).session_id);
                // The init event carries the model the SDK actually resolved —
                // ground truth, as opposed to what we asked for. Pinned on the
                // first turn (write-once) and reused for every later turn.
                const resolvedModel = (message as any).model;
                if ((message as any).subtype === 'init' && typeof resolvedModel === 'string' && resolvedModel) {
                  setSessionModelInfo(sessionId, { model: resolvedModel });
                }
                // The init event also carries the real connection state of
                // every MCP server the session ended up with. Record it so
                // Settings → Connectors can show observed status instead of a
                // guess, without having to hold a session open itself.
                const mcpServers = (message as any).mcp_servers;
                if ((message as any).subtype === 'init' && Array.isArray(mcpServers)) {
                  recordConnectorStatus(mcpServers.map((s: any) => ({
                    name: s?.name,
                    status: s?.status ?? 'unknown',
                    error: s?.error,
                    toolCount: Array.isArray(s?.tools) ? s.tools.length : undefined,
                    scope: s?.scope,
                  })));
                }
              }
              if (message.type === 'assistant' && (message as any).message?.content) {
                insertMessage(sessionId, 'assistant', JSON.stringify((message as any).message.content), turnState.currentMessageId ?? undefined);
                collectKnowledgeSignals((message as any).message.content, turnState);
              }
              if (message.type === 'user' && (message as any).message?.content) {
                const content = (message as any).message.content;
                if (Array.isArray(content)) {
                  const hasToolResults = content.some((b: any) => typeof b !== 'string' && b.type === 'tool_result');
                  if (hasToolResults) {
                    insertMessage(sessionId, 'tool_result', JSON.stringify(content), turnState.currentMessageId ?? undefined);
                  }
                }
              }
              if (message.type === 'result') {
                const completedMessageId = turnState.currentMessageId;
                // The model never saw this message (isSwallowedResumeTurn):
                // this result is NOT the end of the turn. Absorb it — no result
                // row, no turn-complete, turnInProgress stays set and
                // currentMessageId stays for the real answer to correlate to —
                // and let the session decide between waiting for the CLI's own
                // follow-up and re-sending. Only when the ladder is exhausted
                // does the turn complete, and then with text, not silence.
                if (isSwallowedResumeTurn(message, turnState)) {
                  if (onSwallowedResult?.()) continue;
                  if (turnState.redelivered) {
                    log.warn(`[AgentSession] Redelivered turn came back empty as well (sessionId=${sessionId}); surfacing it`);
                    insertMessage(
                      sessionId,
                      'assistant',
                      JSON.stringify([{ type: 'text', text: SWALLOWED_TURN_MESSAGE }]),
                      completedMessageId ?? undefined,
                    );
                    emitEvent({ type: 'text', text: SWALLOWED_TURN_MESSAGE });
                  }
                }
                // A real result ends the wait, whichever turn produced it.
                if (turnState.swallowWatchdog) {
                  clearTimeout(turnState.swallowWatchdog);
                  turnState.swallowWatchdog = null;
                }
                log.info(`[AgentSession:SSE] RESULT received, emitting turn-complete messageId=${completedMessageId ?? '(none)'}`);
                // An overflow is fatal to the transcript, not to the thread.
                // Every later turn resumes the same oversized history and is
                // rejected identically, so without dropping the resume pointer
                // the chat is dead permanently — typing "Hi" fails too. Handled
                // BEFORE the result row is written: cleanupOrphanTurnRows sweeps
                // assistant rows that land after the last result, so the
                // explanation has to precede it to survive the next boot.
                if (isContextOverflowResult(message)) {
                  log.warn(
                    `[AgentSession] Context window exceeded for sessionId=${sessionId}; ` +
                    'dropping the resume pointer so the next turn starts a fresh agent session',
                  );
                  clearSdkSessionId(sessionId);
                  turnState.resumeDisabled = true;
                  insertMessage(
                    sessionId,
                    'assistant',
                    JSON.stringify([{ type: 'text', text: CONTEXT_OVERFLOW_MESSAGE }]),
                    completedMessageId ?? undefined,
                  );
                  emitEvent({ type: 'text', text: CONTEXT_OVERFLOW_MESSAGE });
                }
                insertMessage(sessionId, 'result', JSON.stringify({
                  subtype: (message as any).subtype,
                  result: (message as any).subtype === 'success' ? (message as any).result : undefined,
                  is_error: (message as any).is_error,
                }), completedMessageId ?? undefined);
                // Did this turn go to the warehouse without consulting the
                // ledger? Evaluated here rather than incrementally because the
                // rule is about the WHOLE turn: a findings read in the last
                // tool call still counts.
                try {
                  const raised = noteTurn({
                    sessionId,
                    chatTitle: getSession(sessionId)?.title,
                    toolNames: turnState.toolNames,
                    readPaths: turnState.readPaths,
                    // Hosted MCP servers are local processes, not warehouses —
                    // see `connectorIdOfTool`. Supplied from here because
                    // `omissionWatch` is pure over tool names and importing
                    // `mcpHost` there would create a cycle through this module.
                    hostedIds: mcpHost.hostedIds(),
                  });
                  if (raised) {
                    log.info(
                      `[Knowledge] Turn used ${raised.connectors?.join(', ')} without reading the findings ledger `
                      + `(sessionId=${sessionId})`,
                    );
                  }
                } catch (err) {
                  log.warn(`[Knowledge] omission watch failed: ${(err as Error).message}`);
                }
                // Clear turnInProgress BEFORE emitting turn-complete so any
                // listener that reacts to the event (e.g. registry's
                // deferred-destroy hook) sees the up-to-date state.
                turnState.turnInProgress = false;
                noteTurnEnded(sessionId);
                emitEvent({ type: 'turn-complete', messageId: completedMessageId ?? undefined } as ChatStreamMessage);
                // Turn over — clear so a subsequent send's messageId isn't
                // inherited if the SSE stream emits stray events.
                turnState.currentMessageId = null;
              }
            } catch (err) {
              log.error('[AgentSession] Failed to parse SSE message:', err);
            }
          } else if (eventType === 'mcp-call') {
            // MCP tool call relay: dispatch to host MCP server and POST result back
            try {
              const mcpCall = JSON.parse(data);
              const { callId, serverName, toolName, args } = mcpCall;
              log.debug(`[AgentSession] MCP relay: ${serverName}/${toolName} (callId=${callId})`);

              const resultUrl = `${agentBaseUrl}/sessions/${agentSessionId}/mcp-result`;
              handleMcpRelay(serverName, toolName, args).then((result) => {
                postMcpResultWithRetry(resultUrl, JSON.stringify({ callId, result }), callId);
              }).catch((err) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                postMcpResultWithRetry(resultUrl, JSON.stringify({ callId, error: errorMsg }), callId);
              });
            } catch (err) {
              log.error('[AgentSession] Failed to parse mcp-call event:', err);
            }
          } else if (eventType === 'done') {
            log.info(`[AgentSession:SSE] DONE event received`);
            emitDone();
            resolve();
          } else if (eventType === 'error') {
            try {
              const errData = JSON.parse(data);
              const errorMsg = errData.error || 'Unknown agent error';
              if (canRetryAuth && isAuthError(errorMsg)) {
                reject(new AuthRetryError(errorMsg));
              } else {
                emitError(errorMsg);
                resolve();
              }
            } catch {
              emitError('Unknown agent error');
              resolve();
            }
          }
        }
      });

      res.on('end', () => resolve());
      res.on('error', (err) => {
        if (!sessionState.stopped) reject(err);
        else resolve();
      });
    });

    req.on('error', (err) => {
      if (!sessionState.stopped) reject(err);
      else resolve();
    });

    onRequest(req);
    req.end();
  });
}

// ─── Message Processing ───────────────────────────────────────────

export interface MessageProcessingState {
  currentToolCallId: string | null;
  currentBlockIsThinking: boolean;
  pendingBashCalls: Map<string, { command: string }>;
  /** Fired the moment a scaffold command or an open-tool call names a mini-app
   *  dir, so the owning chat can be linked deterministically — see
   *  `appChatLink.ts` for why the after-the-fact message scan misses this. */
  onAppLink?: (dirName: string, via: 'scaffold' | 'open') => void;
}

export function processQueryMessage(
  message: SDKMessage,
  state: MessageProcessingState,
  onEvent: (msg: ChatStreamMessage) => void,
): void {
  if (message.type === 'stream_event') {
    const event = (message as any).event;

    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        state.currentToolCallId = event.content_block.id;
        onEvent({
          type: 'tool-call-start',
          toolCallId: event.content_block.id,
          toolName: event.content_block.name,
        });
      } else if (event.content_block.type === 'thinking') {
        state.currentBlockIsThinking = true;
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        onEvent({ type: 'text-delta', text: event.delta.text });
      } else if (event.delta.type === 'input_json_delta') {
        onEvent({
          type: 'tool-call-args-delta',
          toolCallId: state.currentToolCallId ?? '',
          argsText: event.delta.partial_json,
        });
      } else if (event.delta.type === 'thinking_delta') {
        onEvent({
          type: 'thinking-delta',
          text: (event.delta as { type: 'thinking_delta'; thinking: string }).thinking,
        });
      }
    } else if (event.type === 'content_block_stop') {
      if (state.currentBlockIsThinking) {
        onEvent({ type: 'thinking-end' });
        state.currentBlockIsThinking = false;
      } else if (state.currentToolCallId) {
        onEvent({ type: 'tool-call-end', toolCallId: state.currentToolCallId });
        state.currentToolCallId = null;
      }
    }
  }

  if (message.type === 'tool_progress') {
    onEvent({
      type: 'tool-progress',
      toolCallId: (message as any).tool_use_id,
      toolName: (message as any).tool_name,
      elapsedSeconds: (message as any).elapsed_time_seconds,
    });
  }

  if (message.type === 'system') {
    const msg = message as any;
    if (msg.subtype === 'task_started' && msg.tool_use_id) {
      onEvent({
        type: 'subagent-started',
        taskId: msg.task_id,
        parentToolCallId: msg.tool_use_id,
        description: msg.description,
      });
    } else if (msg.subtype === 'task_progress' && msg.tool_use_id) {
      onEvent({
        type: 'subagent-progress',
        taskId: msg.task_id,
        parentToolCallId: msg.tool_use_id,
        summary: msg.summary,
        lastToolName: msg.last_tool_name,
        toolUseCount: msg.usage?.tool_uses ?? 0,
        durationMs: msg.usage?.duration_ms ?? 0,
      });
    } else if (msg.subtype === 'task_notification' && msg.tool_use_id) {
      onEvent({
        type: 'subagent-done',
        taskId: msg.task_id,
        parentToolCallId: msg.tool_use_id,
        status: msg.status,
        summary: msg.summary,
      });
    }
  }

  if (message.type === 'assistant' && (message as any).message?.content) {
    for (const block of (message as any).message.content) {
      if (block.type === 'text') {
        onEvent({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        onEvent({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          args: block.input as Record<string, unknown>,
          argsText: JSON.stringify(block.input, null, 2),
        });
        if (block.name === 'Bash') {
          const input = block.input as { command?: string };
          if (input.command) {
            state.pendingBashCalls.set(block.id, { command: input.command });
          }
        }
        const openedDirName = extractOpenedDirName(block);
        if (openedDirName) {
          try {
            state.onAppLink?.(openedDirName, 'open');
          } catch (err) {
            log.warn(`[AppChatLinks] onAppLink (open) failed for ${openedDirName}: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  if (message.type === 'user' && (message as any).message?.content) {
    const content = (message as any).message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== 'string' && block.type === 'tool_result') {
          onEvent({
            type: 'tool-result',
            toolCallId: block.tool_use_id,
            result: block.content,
            isError: block.is_error ?? false,
          });
          const pending = state.pendingBashCalls.get(block.tool_use_id);
          if (pending) {
            state.pendingBashCalls.delete(block.tool_use_id);
            const resultText = extractToolResultText(block.content);
            commandLogger.log({
              command: ['bash', '-c', pending.command],
              stdout: resultText,
              stderr: '',
              exitCode: block.is_error ? 1 : 0,
              appDirName: parseAppDirFromArgs(['bash', '-c', pending.command]),
              source: 'agent',
            });
            const scaffoldedDirName = extractScaffoldedDirName(pending.command, resultText);
            if (scaffoldedDirName) {
              try {
                state.onAppLink?.(scaffoldedDirName, 'scaffold');
              } catch (err) {
                log.warn(`[AppChatLinks] onAppLink (scaffold) failed for ${scaffoldedDirName}: ${(err as Error).message}`);
              }
            }
          }
        }
      }
    }
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}
