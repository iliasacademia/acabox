
import { query, createSdkMcpServer, tool, type SDKUserMessage, type SDKMessage, type HookInput, type SyncHookJSONOutput, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ChatStreamMessage, IPCAttachment, Workspace } from '../shared/types';
import { createSession, setSdkSessionId, insertMessage } from './db/chatRepository';
import { queryActivity } from './activityQuery';
import { app } from 'electron';
import * as fs from 'fs';
import path from 'path';
import log from 'electron-log';
import { z } from 'zod';
import { fork } from 'child_process';
import { containerService } from './containerService';
import { commandLogger, parseAppDirFromArgs } from './commandLogger';

function createActivityMcpServer() {
  return createSdkMcpServer({
    name: 'activity',
    tools: [{
      name: 'query_activity',
      description:
        'Query the user\'s recent activity — browser pages visited and files edited/viewed. ' +
        'Returns raw session data for a time range. Use this to answer questions like ' +
        '"What did I do today?", "What was I reading in the last 2 hours?", ' +
        '"What files was I working on this week?".',
      inputSchema: {
        period: z.enum(['today', 'last_2h', 'last_24h', 'this_week']).optional()
          .describe('Convenience shorthand for common time ranges. Ignored if "since" is provided.'),
        since: z.string().optional()
          .describe('ISO timestamp for custom range start (e.g. "2026-04-06T09:00:00Z"). Overrides "period".'),
        until: z.string().optional()
          .describe('ISO timestamp for custom range end. Defaults to now.'),
        search: z.string().optional()
          .describe('Filter results by title or URL/path content.'),
        source: z.enum(['browser', 'file', 'all']).optional()
          .describe('Which activity source to query. Defaults to "all".'),
        include_content: z.boolean().optional()
          .describe('If true, include full_text and full_text_path for browser sessions, and snapshot_path + full_text_path for file sessions. Defaults to false.'),
      },
      handler: async (args) => {
        const result = queryActivity(args);
        if ('error' in result) {
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }
        const browserCount = result.browser_sessions?.length || 0;
        const fileCount = result.file_sessions?.length || 0;
        const header = `Activity from ${result.query.since} to ${result.query.until}\n` +
          `Browser sessions: ${browserCount} | File sessions: ${fileCount}\n`;
        return { content: [{ type: 'text' as const, text: header + '\n' + JSON.stringify(result, null, 2) }] };
      },
    }],
  });
}

export function getClaudeCliPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  }
  return path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
}

export interface ChatCallbacks {
  onEvent: (msg: ChatStreamMessage) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export interface AgentSession {
  sendMessage(userMessage: string, attachments?: IPCAttachment[]): void;
  destroy(): void;
}

export function createAgentSession(
  sessionId: string,
  callbacks: ChatCallbacks,
  workspace: Workspace,
  sdkSessionId?: string,
): AgentSession {
  const messageQueue = createMessageQueue<UserMessagePayload>();

  createSession(sessionId, workspace.id);

  async function* userMessageGenerator(): AsyncGenerator<SDKUserMessage> {
    for await (const payload of messageQueue) {
      yield {
        type: 'user',
        message: { role: 'user', content: buildContentBlocks(payload) },
      } as SDKUserMessage;
    }
  }

  const state: MessageProcessingState = { currentToolCallId: null, pendingBashCalls: new Map() };

  const workspaceBoundaryHook = createWorkspaceBoundaryHook(workspace.directory_path);

  (async () => {
    try {
      const activityMcpServer = createActivityMcpServer();
      const miniAppServer = createMiniAppMcpServer(workspace.directory_path);

      for await (const message of query({
        prompt: userMessageGenerator(),
        options: {
          pathToClaudeCodeExecutable: getClaudeCliPath(), spawnClaudeCodeProcess: (options: SpawnOptions) => {
            const child = fork(getClaudeCliPath(), options.args.slice(1), {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              silent: true,
            });
            child.stderr?.on('data', (data: Buffer) => {
              for (const line of data.toString().split('\n').filter(Boolean)) {
                log.debug(`[AgentCLI] ${line}`);
              }
            });
            return child as typeof child & { stdin: NonNullable<typeof child.stdin>; stdout: NonNullable<typeof child.stdout> };
          },
          model: 'claude-sonnet-4-6',
          ...(sdkSessionId && { resume: sdkSessionId }),
          includePartialMessages: true,
          cwd: workspace.directory_path,
          env: {
            ...containerService.getPodmanEnv(),
            ANTHROPIC_API_KEY: workspace.api_key,
            MINI_APP_WORKSPACE_DIR: workspace.directory_path,
          },
          settingSources: ['project'],
          mcpServers: { activity: activityMcpServer, 'mini-apps': miniAppServer },
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
            "mcp__activity__query_activity",
            "mcp__mini-apps__open_mini_application",
          ],
          hooks: {
            PreToolUse: [{
              hooks: [workspaceBoundaryHook],
            }],
          },
        },
      })) {
        processQueryMessage(message, state, callbacks.onEvent);

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
          callbacks.onDone();
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      callbacks.onError(errorMessage);
    }
  })();

  return {
    sendMessage(userMessage: string, attachments?: IPCAttachment[]) {
      const storedAttachments = attachments?.map((att) => ({
        type: att.type,
        mediaType: att.mediaType,
        name: att.name,
        title: att.type === 'document' ? att.title : undefined,
      }));
      insertMessage(sessionId, 'user', JSON.stringify({ text: userMessage, attachments: storedAttachments }));
      messageQueue.push({ text: userMessage, attachments });
    },

    destroy() {
      messageQueue.done();
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
        // Extract absolute paths from the command string
        const absolutePathPattern = /(?:^|\s|=|"|')(\/([\w.\-]+\/)+[\w.\-]*)/g;
        let match;
        while ((match = absolutePathPattern.exec(toolInput.command)) !== null) {
          paths.push(match[1]);
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
      }
    } else if (event.type === 'content_block_stop') {
      if (state.currentToolCallId) {
        onEvent({
          type: 'tool-call-end',
          toolCallId: state.currentToolCallId,
        });
        state.currentToolCallId = null;
      }
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
