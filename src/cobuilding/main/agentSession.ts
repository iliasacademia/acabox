import { query, type SDKUserMessage, type SDKMessage, type HookInput, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ChatStreamMessage, IPCAttachment, Workspace } from '../shared/types';
import { createSession, setSdkSessionId, insertMessage } from './db/chatRepository';
import path from 'path';
import log from 'electron-log';
import { app } from 'electron';

function getClaudeCliPath(): string {
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

  const state: MessageProcessingState = { currentToolCallId: null };

  const workspaceBoundaryHook = createWorkspaceBoundaryHook(workspace.directory_path);

  (async () => {
    try {
      for await (const message of query({
        prompt: userMessageGenerator(),
        options: {
          pathToClaudeCodeExecutable: getClaudeCliPath(),
          model: 'claude-sonnet-4-6',
          ...(sdkSessionId && { resume: sdkSessionId }),
          includePartialMessages: true,
          cwd: workspace.directory_path,
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: workspace.api_key,
          },
          settingSources: ['project'],
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
        }
      }
    }
  }
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
