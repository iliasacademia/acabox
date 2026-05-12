
import { type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatStreamMessage, IPCAttachment, Workspace, NotificationNavigationAction } from '../shared/types';
import { createSession, setSdkSessionId, insertMessage } from './db/chatRepository';
import * as fs from 'fs';
import path from 'path';
import log from 'electron-log';
import { containerService } from './containerService';
import { commandLogger, parseAppDirFromArgs } from './commandLogger';
import http from 'http';
import { findHostAppForDocument, getRegisteredHostApps, type HostApp } from './hostApps';
import { wordHostApp } from './hostApps/wordHostApp';
import { IDENTITY_PREAMBLE } from './hostApps/identityPreamble';
import { windowMonitorService } from '../../windowMonitorService';

/**
 * Resolve which HostApp this session/turn is acting on. Resolution order:
 *
 *   1. The document path's own scheme/extension (Apple Notes' `applenotes://`,
 *      Google Docs' `gdocs://`, Word's `.docx`, Obsidian's `.md`, ...).
 *   2. The focused window's bundle id, looked up via windowMonitorService —
 *      covers the case where the overlay is up over Chrome but the browser
 *      extension hasn't reported a Google Docs URL yet (so the agent still
 *      binds to the google-docs host instead of falling back to Word).
 *   3. The pre-HostApp default: Word, then the first registered host, then the
 *      hardcoded wordHostApp module (so non-Word builds with no registered
 *      hosts at all still get *something* — should never happen in practice).
 */
export function resolveSessionHostApp(documentPath: string | null | undefined): HostApp {
  const registered = getRegisteredHostApps();
  const fromDoc = findHostAppForDocument(documentPath ?? null);
  if (fromDoc) return fromDoc;
  try {
    const focusedId = windowMonitorService.getFocusedWindowId();
    if (focusedId) {
      const hostId = windowMonitorService.getHostAppIdForWindow(focusedId);
      if (hostId) {
        const fromWindow = registered.find((h) => h.id === hostId);
        if (fromWindow) return fromWindow;
      }
    }
  } catch {
    // windowMonitorService unavailable (scheduled tasks, tests) — fall through.
  }
  return registered.find((h) => h.id === wordHostApp.id) ?? registered[0] ?? wordHostApp;
}

// ─── MCP Relay Dispatch ──────────────────────────────────────────
// Maps MCP tool calls from the in-container agent to host-side MCP server handlers.
// The host MCP servers are stored on globalThis by startAgentInfrastructure().

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function handleMcpRelay(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const mcpServers = (globalThis as any).__hostMcpServers as Record<string, any> | undefined;
  if (!mcpServers) {
    return { content: [{ type: 'text', text: 'Host MCP servers not available.' }], isError: true };
  }

  const serverHandler = mcpServers[serverName];
  if (!serverHandler) {
    return { content: [{ type: 'text', text: `Unknown MCP server: ${serverName}` }], isError: true };
  }

  const toolHandler = serverHandler[toolName];
  if (!toolHandler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${serverName}/${toolName}` }], isError: true };
  }

  try {
    return await toolHandler(args);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `MCP call failed: ${msg}` }], isError: true };
  }
}



export interface ChatCallbacks {
  onEvent: (msg: ChatStreamMessage) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export interface AgentSession {
  sendMessage(userMessage: string, attachments?: IPCAttachment[]): void;
  destroy(): void;
  addListener(callbacks: Partial<ChatCallbacks>): () => void;
  readonly isRunning: boolean;
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
): AgentSession {
  const listeners = new Set<Partial<ChatCallbacks>>();
  let running = true;
  let agentSessionId: string | null = null;
  let sseRequest: http.ClientRequest | null = null;
  const pendingMessages: Array<{ text: string; attachments?: IPCAttachment[] }> = [];
  const sessionState = { stopped: false }; // object so connectSSE sees mutations by reference

  // Register the initial callbacks as the first listener
  listeners.add(callbacks);

  function emitEvent(msg: ChatStreamMessage) {
    if (msg.type !== 'heartbeat') {
      running = true;
    }
    for (const listener of listeners) {
      listener.onEvent?.(msg);
    }
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
    for (const listener of [...listeners]) {
      listener.onError?.(error);
    }
  }

  createSession(sessionId, workspace.id, source ?? null, documentPath ?? null);

  // Resolve which host app this session is acting on. See resolveSessionHostApp
  // for the resolution order — document path first, focused-window bundle id
  // as a backstop, then Word fallback.
  const sessionHostApp: HostApp = resolveSessionHostApp(documentPath);

  const state: MessageProcessingState = { currentToolCallId: null, currentBlockIsThinking: false, pendingBashCalls: new Map() };

  // ─── Agent Server Communication ───────────────────────────────

  // Wait for the agent server to be ready before connecting.
  // Emits status updates so the spinner shows the right label:
  //   "Waiting for agent container..." — container isn't running yet
  //   "Waiting for agent..."           — container is up, agent server isn't responding
  async function waitForAgent(): Promise<string> {
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();
    let anyStatusEmitted = false;
    while (!sessionState.stopped) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        throw new Error('Agent failed to start. Please check that the container is running in the Debug panel.');
      }
      const isRunning = containerService.isRunning();
      const port = containerService.getAgentPort();

      let status = '';
      if (!isRunning) {
        status = 'Waiting for agent container...';
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
    const soulPath = path.join(workspace.directory_path, '.academia', 'SOUL.md');
    const content = fs.readFileSync(soulPath, 'utf-8').trim();
    if (content) soulMdContent = content;
  } catch { /* doesn't exist */ }

  // Build system prompt using the host app's guidance (replaces hardcoded docx guidance)
  const hostGuidance = [IDENTITY_PREAMBLE, sessionHostApp.systemPromptAppend]
    .filter(Boolean)
    .join('\n\n');

  (async () => {
    try {
      // Wait for the agent server to be ready (emits status updates automatically)
      agentBaseUrl = await waitForAgent();

      // Create session on the agent server.
      // Sessions are persisted via a custom sessionStore that writes JSONL files
      // to /data/.academia/sessions/ on the workspace mount. This enables full
      // resume — the agent retains context across app restarts.
      const createBody = JSON.stringify({
        sessionId,
        resumeSessionId: sdkSessionId,
        model: model || undefined,
        soulMd: soulMdContent,
        hostGuidance,
      });

      const createRes = await httpPost(`${agentBaseUrl}/sessions`, createBody);
      const createData = JSON.parse(createRes);
      agentSessionId = createData.sessionId;
      log.debug(`[AgentSession] Session created: ${agentSessionId}`);

      // Flush any messages that arrived before the session was ready
      for (const pending of pendingMessages) {
        httpPost(
          `${agentBaseUrl}/sessions/${agentSessionId}/messages`,
          JSON.stringify({ text: pending.text, attachments: pending.attachments }),
        ).catch((err) => log.error('[AgentSession] Failed to send pending message:', err));
      }
      pendingMessages.length = 0;

      // Connect to SSE event stream
      const eventUrl = `${agentBaseUrl}/sessions/${agentSessionId}/events`;
      await connectSSE(eventUrl, state, sessionId, emitEvent, emitDone, emitError, sessionState, (req) => {
        sseRequest = req;
      }, agentBaseUrl, agentSessionId!);
    } catch (err: unknown) {
      if (sessionState.stopped) {
        emitDone();
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        emitError(errorMessage);
      }
    } finally {
      if (running) {
        emitDone();
      }
    }
  })();

  return {
    sendMessage(userMessage: string, attachments?: IPCAttachment[]) {
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
      insertMessage(sessionId, 'user', JSON.stringify({ text: userMessage, attachments: storedAttachments }));
      // Broadcast the user message to every surface subscribed to this
      // session. Without this, a message typed in the overlay would land
      // in SQLite but the desktop chat (subscribing via IPC fanout) would
      // never see the user turn — only the assistant's streamed reply.
      log.info(`[AgentSession] emitting user-message sessionId=${sessionId} textLen=${userMessage.length}`);
      emitEvent({ type: 'user-message', text: userMessage });

      const processedText = messagePreprocessor ? messagePreprocessor(userMessage) : userMessage;

      // Translate file attachment paths from host to container
      const translatedAttachments = attachments?.map((att) => {
        if (att.type === 'file_reference' && att.filePath?.startsWith(workspace.directory_path)) {
          return { ...att, filePath: '/data' + att.filePath.slice(workspace.directory_path.length) };
        }
        return att;
      });

      if (agentSessionId) {
        httpPost(
          `${agentBaseUrl}/sessions/${agentSessionId}/messages`,
          JSON.stringify({ text: processedText, attachments: translatedAttachments }),
        ).catch((err) => log.error('[AgentSession] Failed to send message:', err));
      } else {
        // Session not ready yet — queue the message for delivery after creation
        log.debug('[AgentSession] Session not ready, queuing message');
        pendingMessages.push({ text: processedText, attachments: translatedAttachments });
      }
    },

    destroy() {
      sessionState.stopped = true;
      clearInterval(heartbeatTimer);
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

function httpPost(url: string, body: string): Promise<string> {
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
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
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

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7);
            } else if (line.startsWith('data: ')) {
              data = line.slice(6);
            }
          }

          if (!eventType || !data) continue;

          if (eventType === 'message') {
            try {
              const message = JSON.parse(data) as SDKMessage;
              processQueryMessage(message, state, emitEvent);

              if (message.type === 'system') {
                setSdkSessionId(sessionId, (message as any).session_id);
              }
              if (message.type === 'assistant' && (message as any).message?.content) {
                insertMessage(sessionId, 'assistant', JSON.stringify((message as any).message.content));
              }
              if (message.type === 'user' && (message as any).message?.content) {
                const content = (message as any).message.content;
                if (Array.isArray(content)) {
                  const hasToolResults = content.some((b: any) => typeof b !== 'string' && b.type === 'tool_result');
                  if (hasToolResults) {
                    insertMessage(sessionId, 'tool_result', JSON.stringify(content));
                  }
                }
              }
              if (message.type === 'result') {
                insertMessage(sessionId, 'result', JSON.stringify({
                  subtype: (message as any).subtype,
                  result: (message as any).subtype === 'success' ? (message as any).result : undefined,
                  is_error: (message as any).is_error,
                }));
                emitDone();
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

              handleMcpRelay(serverName, toolName, args).then((result) => {
                httpPost(
                  `${agentBaseUrl}/sessions/${agentSessionId}/mcp-result`,
                  JSON.stringify({ callId, result }),
                ).catch((err) => log.error('[AgentSession] Failed to POST mcp-result:', err));
              }).catch((err) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                httpPost(
                  `${agentBaseUrl}/sessions/${agentSessionId}/mcp-result`,
                  JSON.stringify({ callId, error: errorMsg }),
                ).catch((err2) => log.error('[AgentSession] Failed to POST mcp-result error:', err2));
              });
            } catch (err) {
              log.error('[AgentSession] Failed to parse mcp-call event:', err);
            }
          } else if (eventType === 'done') {
            emitDone();
            resolve();
          } else if (eventType === 'error') {
            try {
              const errData = JSON.parse(data);
              emitError(errData.error || 'Unknown agent error');
            } catch {
              emitError('Unknown agent error');
            }
            resolve();
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

interface MessageProcessingState {
  currentToolCallId: string | null;
  currentBlockIsThinking: boolean;
  pendingBashCalls: Map<string, { command: string }>;
}

function processQueryMessage(
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
