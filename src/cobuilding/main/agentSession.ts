import { query, type SDKUserMessage, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatStreamMessage, Workspace } from '../shared/types';
import { createSession, setSdkSessionId, insertMessage } from './db/chatRepository';

export interface ChatCallbacks {
  onEvent: (msg: ChatStreamMessage) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export interface AgentSession {
  sendMessage(userMessage: string): void;
  destroy(): void;
}

export function createAgentSession(
  sessionId: string,
  callbacks: ChatCallbacks,
  workspace: Workspace,
  sdkSessionId?: string,
): AgentSession {
  const messageQueue = createMessageQueue<string>();

  createSession(sessionId, workspace.id);

  async function* userMessageGenerator(): AsyncGenerator<SDKUserMessage> {
    for await (const text of messageQueue) {
      yield {
        type: 'user',
        message: { role: 'user', content: text },
      } as SDKUserMessage;
    }
  }

  const state: MessageProcessingState = { currentToolCallId: null };

  (async () => {
    try {
      for await (const message of query({
        prompt: userMessageGenerator(),
        options: {
          model: 'claude-sonnet-4-6',
          ...(sdkSessionId && { resume: sdkSessionId }),
          includePartialMessages: true,
          cwd: workspace.directory_path,
          env: { ...process.env, ANTHROPIC_API_KEY: workspace.api_key },
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
    sendMessage(userMessage: string) {
      insertMessage(sessionId, 'user', userMessage);
      messageQueue.push(userMessage);
    },

    destroy() {
      messageQueue.done();
    },
  };
}

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
