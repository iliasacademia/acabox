/**
 * HTTP/SSE-based chat adapter for the Word overlay popup.
 *
 * Mirrors the IPC-based chatAdapter.ts from the desktop app but uses
 * HTTP fetch + SSE streaming instead of Electron IPC.
 */

import { useMemo } from 'react';
import type { ChatModelAdapter, ThreadAssistantMessagePart, ToolCallMessagePart } from '@assistant-ui/react';
import type { ChatStreamMessage } from '../../cobuilding/shared/types';

/**
 * Builds response content from a stream of ChatStreamMessage events.
 * This is the same logic as responseBuilder() in the desktop chatAdapter.ts
 * but without the progress store side effects (which depend on Electron IPC).
 */
function responseBuilder() {
  const messages: ThreadAssistantMessagePart[] = [];
  let streamingText = '';
  let streamingReasoning = '';
  let streamingToolCall: { toolCallId: string; toolName: string; argsText: string } | null = null;

  const getContent = (): ThreadAssistantMessagePart[] => {
    const content: ThreadAssistantMessagePart[] = [...messages];
    if (streamingReasoning) content.push({ type: 'reasoning', text: streamingReasoning });
    if (streamingText) content.push({ type: 'text', text: streamingText });
    if (streamingToolCall) {
      content.push({
        type: 'tool-call',
        toolCallId: streamingToolCall.toolCallId,
        toolName: streamingToolCall.toolName,
        args: {} as any,
        argsText: streamingToolCall.argsText,
      });
    }
    return content;
  };

  const onMessage = (msg: ChatStreamMessage) => {
    switch (msg.type) {
      case 'thinking-delta':
        streamingReasoning += msg.text;
        return;
      case 'thinking-end':
        if (streamingReasoning) {
          messages.push({ type: 'reasoning', text: streamingReasoning });
          streamingReasoning = '';
        }
        return;
      case 'text-delta':
        streamingText += msg.text;
        return;
      case 'tool-call-start':
        streamingToolCall = { toolCallId: msg.toolCallId, toolName: msg.toolName, argsText: '' };
        return;
      case 'tool-call-args-delta':
        if (streamingToolCall) streamingToolCall.argsText += msg.argsText;
        return;
      case 'tool-call-end':
        streamingToolCall = null;
        return;
      case 'text':
        streamingText = '';
        messages.push(msg);
        return;
      case 'tool-call':
        streamingToolCall = null;
        messages.push({
          type: 'tool-call',
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          args: msg.args as any,
          argsText: msg.argsText,
        });
        return;
      case 'tool-result': {
        const idx = messages.findIndex(m => m.type === 'tool-call' && m.toolCallId === msg.toolCallId);
        if (idx !== -1) {
          messages[idx] = { ...(messages[idx] as ToolCallMessagePart), result: msg.result, isError: msg.isError };
        }
        return;
      }
      // Ignore heartbeat, tool-progress, subagent events in the popup
    }
  };

  return { onMessage, getContent };
}

/**
 * Parse SSE stream from the /api/cobuilding/sessions/:id/send endpoint.
 */
async function* parseSSEStream(
  response: Response,
  abortSignal: AbortSignal,
): AsyncIterable<ChatStreamMessage> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (abortSignal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const match = part.match(/^event: (\w+)\ndata: (.+)$/s);
        if (!match) continue;
        const [, eventType, dataStr] = match;
        try {
          const data = JSON.parse(dataStr);
          if (eventType === 'event') yield data as ChatStreamMessage;
          else if (eventType === 'done') return;
          else if (eventType === 'error') return;
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface HttpChatAdapterOptions {
  serverUrl: string;
  token: string | null;
  sessionId: string;
  /** Called to get context (document path, selected text) at send time */
  getContext: () => { documentPath?: string | null; selectedText?: string | null };
}

function createHttpChatAdapter(opts: HttpChatAdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      if (!lastUserMessage) return;

      const userText = lastUserMessage.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join('');

      const ctx = opts.getContext();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

      const res = await fetch(`${opts.serverUrl}/api/cobuilding/sessions/${opts.sessionId}/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: userText,
          ...(ctx.documentPath ? { documentPath: ctx.documentPath } : {}),
          ...(ctx.selectedText ? { selectedText: ctx.selectedText } : {}),
        }),
        signal: abortSignal,
      });

      const response = responseBuilder();

      for await (const msg of parseSSEStream(res, abortSignal)) {
        if (abortSignal.aborted) break;
        response.onMessage(msg);
        yield { content: response.getContent() };
      }
    },
  };
}

export function useHttpChatAdapter(opts: HttpChatAdapterOptions): ChatModelAdapter {
  return useMemo(
    () => createHttpChatAdapter(opts),
    [opts.serverUrl, opts.token, opts.sessionId],
  );
}
