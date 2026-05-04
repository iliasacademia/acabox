
import { query, createSdkMcpServer, tool, type Query, type SDKUserMessage, type SDKMessage, type HookInput, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ChatStreamMessage, IPCAttachment, Workspace, NotificationNavigationAction } from '../shared/types';
import { createSession, setSdkSessionId, insertMessage } from './db/chatRepository';
import * as fs from 'fs';
import path from 'path';
import log from 'electron-log';
import { z } from 'zod';
import { containerService } from './containerService';
import { commandLogger, parseAppDirFromArgs } from './commandLogger';
import { createActivityMcpServer } from './mcpServers/activityMcpServer';
import { createNotificationMcpServer } from './mcpServers/notificationMcpServer';
import { createReactionMcpServer } from './mcpServers/reactionMcpServer';
import { createCiteRightMcpServer } from './mcpServers/citeRightMcpServer';
import { createZoteroMcpServer } from './mcpServers/zoteroMcpServer';
import { resolveClaudeBinary } from './sdkBinarySetup';
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
  const messageQueue = createMessageQueue<UserMessagePayload>();
  const listeners = new Set<Partial<ChatCallbacks>>();
  let running = true;
  let queryInstance: Query | null = null;
  let stopped = false;

  // Register the initial callbacks as the first listener
  listeners.add(callbacks);

  function emitEvent(msg: ChatStreamMessage) {
    // Mark as running when real (non-heartbeat) events arrive — this re-enables
    // the heartbeat after a turn boundary (emitDone sets running = false).
    if (msg.type !== 'heartbeat') {
      running = true;
    }
    for (const listener of listeners) {
      listener.onEvent?.(msg);
    }
  }

  // Heartbeat: emit periodic signals so the renderer knows the agent is alive.
  // This prevents the renderer's idle timeout from disconnecting during long operations.
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const heartbeatTimer = setInterval(() => {
    if (running) {
      emitEvent({ type: 'heartbeat' });
    }
  }, HEARTBEAT_INTERVAL_MS);

  function emitDone() {
    running = false;
    // Note: heartbeat timer is NOT cleared here because emitDone fires after each
    // conversation turn, not at session end. The timer is self-guarded (checks `running`),
    // and `running` is set back to true when the next turn starts processing events.
    // Timer is only cleared in destroy() (session teardown) and emitError() (terminal).
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

  async function* userMessageGenerator(): AsyncGenerator<SDKUserMessage> {
    for await (const payload of messageQueue) {
      yield {
        type: 'user',
        message: { role: 'user', content: buildContentBlocks(payload) },
      } as SDKUserMessage;
    }
  }

  const state: MessageProcessingState = { currentToolCallId: null, currentBlockIsThinking: false, pendingBashCalls: new Map() };

  const workspaceBoundaryHook = createWorkspaceBoundaryHook(workspace.directory_path);
  const hostPreToolHooks = sessionHostApp.preToolHooks ?? [];

  (async () => {
    try {
      const activityMcpServer = createActivityMcpServer();
      const miniAppServer = createMiniAppMcpServer(workspace.directory_path);
      const notificationServer = createNotificationMcpServer(onNotificationClick);
      const reactionServer = createReactionMcpServer(workspace.id);
      const hostMcpServer = sessionHostApp.createMcpServer(workspace.directory_path);
      const citeRightServer = createCiteRightMcpServer();
      const zoteroServer = createZoteroMcpServer();

      // Read SOUL.md for system prompt customization
      let soulMdContent: string | undefined;
      try {
        const soulPath = path.join(workspace.directory_path, '.academia', 'SOUL.md');
        const content = fs.readFileSync(soulPath, 'utf-8').trim();
        if (content) {
          soulMdContent = content;
        }
      } catch {
        // File doesn't exist or can't be read — use default prompt
      }

      const claudeBinaryPath = resolveClaudeBinary();
      if (!claudeBinaryPath) {
        emitError('Claude agent binary not found. Please reinstall the application.');
        return;
      }

      queryInstance = query({
        prompt: userMessageGenerator(),
        options: {
          pathToClaudeCodeExecutable: claudeBinaryPath,
          stderr: (data: string) => {
            for (const line of data.split('\n').filter(Boolean)) {
              log.debug(`[AgentCLI] ${line}`);
            }
          },
          model: model || 'claude-opus-4-7',
          thinking: { type: 'adaptive' },
          systemPrompt: (() => {
            const hostGuidance = [IDENTITY_PREAMBLE, sessionHostApp.systemPromptAppend]
              .filter(Boolean)
              .join('\n\n');
            const appendParts = [soulMdContent, hostGuidance].filter(Boolean).join('\n\n');
            return { type: 'preset' as const, preset: 'claude_code' as const, append: appendParts };
          })(),
          ...(sdkSessionId && { resume: sdkSessionId }),
          includePartialMessages: true,
          cwd: workspace.directory_path,
          env: {
            ...containerService.getPodmanEnv(),
            ANTHROPIC_API_KEY: workspace.api_key,
            MINI_APP_WORKSPACE_DIR: workspace.directory_path,
          },
          settingSources: ['project'],
          mcpServers: {
            activity: activityMcpServer,
            'mini-apps': miniAppServer,
            notification: notificationServer,
            reaction: reactionServer,
            [sessionHostApp.mcpServerKey]: hostMcpServer,
            citeright: citeRightServer,
            zotero: zoteroServer,
          },
          allowedTools: [
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
            "Agent",
            "NotebookEdit",
            "WebSearch",
            "Skill",
            "TodoWrite",
            "EnterPlanMode",
            "ExitPlanMode",
            "mcp__activity__query_activity",
            "mcp__mini-apps__open_mini_application",
            "mcp__notification__show_notification",
            "mcp__reaction__create_reaction_thread",
            ...sessionHostApp.allowedTools,
            "mcp__citeright__find_references",
            "mcp__citeright__create_citation_report",
            "mcp__citeright__get_citation_report",
            "mcp__citeright__add_claim_to_report",
            "mcp__citeright__search_citations_for_claim",
            "mcp__citeright__format_citations",
            "mcp__citeright__list_citation_reports",
            "mcp__zotero__status",
            "mcp__zotero__search_library",
            "mcp__zotero__get_item",
            "mcp__zotero__add_doi",
          ],
          hooks: {
            PreToolUse: [{
              hooks: [workspaceBoundaryHook, ...hostPreToolHooks],
            }],
          },
        },
      });

      for await (const message of queryInstance) {
        processQueryMessage(message, state, emitEvent);

        if (message.type === 'system') {
          setSdkSessionId(sessionId, message.session_id);
        }

        if (message.type === 'assistant') {
          insertMessage(sessionId, 'assistant', JSON.stringify(message.message.content));
        }

        if (message.type === 'user') {
          const content = message.message.content;
          if (Array.isArray(content)) {
            const hasToolResults = content.some(
              (block) => typeof block !== 'string' && block.type === 'tool_result',
            );
            if (hasToolResults) {
              insertMessage(sessionId, 'tool_result', JSON.stringify(content));
            }
          }
        }

        if (message.type === 'result') {
          insertMessage(
            sessionId,
            'result',
            JSON.stringify({
              subtype: message.subtype,
              result: message.subtype === 'success' ? message.result : undefined,
              is_error: message.is_error,
            }),
          );
          emitDone();
        }
      }
    } catch (err: unknown) {
      if (stopped) {
        emitDone();
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        emitError(errorMessage);
      }
    } finally {
      queryInstance = null;
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
      const processedText = messagePreprocessor ? messagePreprocessor(userMessage) : userMessage;
      messageQueue.push({ text: processedText, attachments });
    },

    destroy() {
      stopped = true;
      clearInterval(heartbeatTimer);
      if (queryInstance) {
        queryInstance.close();
        queryInstance = null;
      }
      messageQueue.done();
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

type UserMessagePayload = {
  text: string;
  attachments?: IPCAttachment[];
};

function buildContentBlocks(payload: UserMessagePayload): string | ContentBlockParam[] {
  const { text, attachments } = payload;

  if (!attachments || attachments.length === 0) {
    return text;
  }

  const blocks: ContentBlockParam[] = [];

  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: attachment.data,
        },
      });
    } else if (attachment.type === 'document') {
      if (attachment.mediaType === 'application/pdf') {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: attachment.data,
          },
          title: attachment.title ?? null,
        });
      } else {
        // Text-based documents: decode base64 to string
        const textContent = Buffer.from(attachment.data, 'base64').toString('utf-8');
        blocks.push({
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: textContent,
          },
          title: attachment.title ?? null,
        });
      }
    } else if (attachment.type === 'file_reference') {
      blocks.push({
        type: 'text',
        text: `[Attached file: ${attachment.filePath}]\nThis file has been placed in the workspace. You may need to preprocess it before use (e.g., use podman to convert an Excel file to CSV).`,
      });
    }
  }

  if (text) {
    blocks.push({ type: 'text', text });
  }

  return blocks;
}

// ─── Mini-App MCP Server ─────────────────────────────────────────

function createMiniAppMcpServer(workspaceDir: string) {
  return createSdkMcpServer({
    name: 'mini-apps',
    tools: [
      tool(
        'open_mini_application',
        'Open an existing mini-application in the UI. The mini-application will take over the center content area and the chat will move to the right sidebar.',
        {
          dir_name: z.string().describe('The directory name of the mini-application (the lowerCamelCase name under .applications/)'),
        },
        async (args) => {
          const appDir = path.join(workspaceDir, '.applications', args.dir_name);
          const exists = await fs.promises.access(appDir).then(() => true, () => false);
          if (!exists) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Mini-application directory not found: .applications/${args.dir_name}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Opened mini-application: ${args.dir_name}`,
              },
            ],
          };
        },
      ),
    ],
  });
}

// ─── Workspace Boundary Hook ──────────────────────────────────────

function isWithinWorkspace(filePath: string, workspaceDir: string): boolean {
  const resolved = path.resolve(workspaceDir, filePath);
  return resolved === workspaceDir || resolved.startsWith(workspaceDir + path.sep);
}

function extractPathsFromToolInput(toolName: string, toolInput: Record<string, unknown>): string[] {
  const paths: string[] = [];

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      if (typeof toolInput.file_path === 'string') {
        paths.push(toolInput.file_path);
      }
      break;

    case 'Glob':
    case 'Grep':
      if (typeof toolInput.path === 'string') {
        paths.push(toolInput.path);
      }
      break;

    case 'NotebookEdit':
      if (typeof toolInput.notebook_path === 'string') {
        paths.push(toolInput.notebook_path);
      }
      break;

    case 'Bash': {
      if (typeof toolInput.command === 'string') {
        const cmd = toolInput.command;
        // Skip path validation for podman exec commands — paths after the
        // container name are container-internal (e.g. /data/...) and the
        // container's volume mount already restricts access to the workspace.
        const shellCmd = cmd.replace(/^.*?&&\s*/, '');
        if (/^\s*podman\s+exec\b/.test(shellCmd)) {
          break;
        }
        // Extract absolute paths from the command string
        // 1. Quoted paths (double or single quotes)
        const quotedPathPattern = /["'](\/[^"']+)["']/g;
        let match;
        while ((match = quotedPathPattern.exec(cmd)) !== null) {
          paths.push(match[1]);
        }
        // 2. Unquoted paths (may contain escaped spaces)
        const unquotedPathPattern = /(?:^|\s|=)(\/([\w.\-]|\\ )+(?:\/([\w.\-]|\\ )+)*)/g;
        while ((match = unquotedPathPattern.exec(cmd)) !== null) {
          // Unescape backslash-spaces to get the real path
          paths.push(match[1].replace(/\\ /g, ' '));
        }
      }
      break;
    }
  }

  return paths;
}

function createWorkspaceBoundaryHook(workspaceDir: string) {
  const resolvedWorkspace = path.resolve(workspaceDir);

  return async (input: HookInput, _toolUseID: string | undefined, _options: { signal: AbortSignal }): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }

    const { tool_name, tool_input } = input;

    // Tools without filesystem access are always allowed
    const fsTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Bash'];
    if (!fsTools.includes(tool_name)) {
      return {};
    }

    const paths = extractPathsFromToolInput(tool_name, (tool_input ?? {}) as Record<string, unknown>);

    for (const p of paths) {
      if (!isWithinWorkspace(p, resolvedWorkspace)) {
        log.warn(`[WorkspaceBoundary] Blocked ${tool_name}: path "${p}" is outside workspace "${resolvedWorkspace}"`);
        return {
          decision: 'block',
          reason: `Path "${p}" is outside the workspace directory. All file operations must stay within "${resolvedWorkspace}".`,
        };
      }
    }

    return {};
  };
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
    const event = message.event;

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
        onEvent({
          type: 'text-delta',
          text: event.delta.text,
        });
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
        onEvent({
          type: 'tool-call-end',
          toolCallId: state.currentToolCallId,
        });
        state.currentToolCallId = null;
      }
    }
  }

  if (message.type === 'tool_progress') {
    onEvent({
      type: 'tool-progress',
      toolCallId: message.tool_use_id,
      toolName: message.tool_name,
      elapsedSeconds: message.elapsed_time_seconds,
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

  if (message.type === 'assistant' && message.message?.content) {
    for (const block of message.message.content) {
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

  if (message.type === 'user' && message.message?.content) {
    const content = message.message.content;
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
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    },

    done() {
      isDone = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false });
          }
          if (isDone) {
            return Promise.resolve({
              value: undefined as unknown as T,
              done: true,
            });
          }
          return new Promise<IteratorResult<T>>((r) => {
            resolve = () => {
              if (pending.length > 0) {
                r({ value: pending.shift()!, done: false });
              } else {
                r({ value: undefined as unknown as T, done: true });
              }
            };
          });
        },
      };
    },
  };
}
