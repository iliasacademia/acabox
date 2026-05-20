/**
 * Chat adapter for the Word overlay popup.
 *
 * Primary path: WebSocket (unified protocol via useOverlayWebSocket).
 * Fallback: HTTP fetch + SSE streaming when WebSocket is unavailable.
 */

import { useMemo, useRef } from 'react';
import type {
  ChatModelAdapter,
  ThreadAssistantMessagePart,
  ToolCallMessagePart,
} from '@assistant-ui/react';
import { ExportedMessageRepository } from '@assistant-ui/react';
import type { ThreadHistoryAdapter } from '@assistant-ui/react';
import type { ChatStreamMessage } from '../../cobuilding/shared/types';
import { convertHistoryMessages, type HistoryDbMessage } from '../../cobuilding/renderer/historyMessageConverter';
import type { OverlayWebSocket } from './useWordPollWebSocket';

/**
 * Builds response content from a stream of ChatStreamMessage events.
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
    }
  };

  return { onMessage, getContent };
}

// ─── SSE fallback (HTTP POST) ────────────────────────────────────────

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
        const eventMatch = part.match(/^event: (\w+)/);
        if (!eventMatch) continue;
        const eventType = eventMatch[1];

        if (eventType === 'done' || eventType === 'error') return;

        const dataMatch = part.match(/\ndata: (.+)$/s);
        if (!dataMatch) continue;
        try {
          const data = JSON.parse(dataMatch[1]);
          if (eventType === 'event') yield data as ChatStreamMessage;
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── WebSocket-based chat adapter ────────────────────────────────────

interface WsChatAdapterOptions {
  overlayWs: OverlayWebSocket;
  sessionId: string;
  getContext: () => { documentPath?: string | null; selectedText?: string | null };
}

function createWsChatAdapter(opts: WsChatAdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      if (!lastUserMessage) return;

      const userText = lastUserMessage.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join('');

      const ctx = opts.getContext();
      const response = responseBuilder();

      // Create a promise that resolves when done/error arrives
      let resolveStream: (() => void) | null = null;
      const pendingEvents: ChatStreamMessage[] = [];
      let streamDone = false;
      let streamError: string | null = null;

      const unsubscribe = opts.overlayWs.subscribeToChatSession(opts.sessionId, {
        onEvent: (msg) => {
          pendingEvents.push(msg);
          resolveStream?.();
        },
        onDone: () => {
          streamDone = true;
          resolveStream?.();
        },
        onError: (err) => {
          streamError = err;
          streamDone = true;
          resolveStream?.();
        },
      });

      // Send the message
      opts.overlayWs.sendChatMessage(
        opts.sessionId,
        userText,
        ctx.documentPath ?? undefined,
        ctx.selectedText ?? undefined,
      );

      try {
        while (!streamDone && !abortSignal.aborted) {
          if (pendingEvents.length === 0) {
            await new Promise<void>((resolve) => {
              resolveStream = resolve;
              // Check abort
              if (abortSignal.aborted) resolve();
            });
            resolveStream = null;
          }

          while (pendingEvents.length > 0) {
            const msg = pendingEvents.shift()!;
            response.onMessage(msg);
            yield { content: response.getContent() };
          }
        }

        if (streamError) {
          throw new Error(streamError);
        }
      } finally {
        unsubscribe();
      }
    },
  };
}

// ─── HTTP/SSE fallback adapter ───────────────────────────────────────

interface HttpChatAdapterOptions {
  serverUrl: string;
  token: string | null;
  sessionId: string;
  getContext: () => { documentPath?: string | null; selectedText?: string | null };
}

function extractOverlayAttachments(message: { attachments?: readonly any[] }): any[] | undefined {
  if (!message.attachments?.length) return undefined;
  const attachments: any[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type === 'file_reference') {
      const textPart = (attachment.content ?? []).find((p: any) => p.type === 'text');
      if (textPart) {
        attachments.push({ type: 'file_reference', filePath: textPart.text, name: attachment.name });
      }
      continue;
    }
    for (const part of attachment.content ?? []) {
      if (part.type === 'image') {
        const match = (part.image as string).match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (match) {
          attachments.push({ type: 'image', data: match[2], mediaType: match[1], name: attachment.name });
        }
      } else if (part.type === 'file') {
        attachments.push({
          type: 'document',
          data: part.data as string,
          mediaType: part.mimeType as string,
          title: part.filename as string | undefined,
          name: attachment.name,
        });
      }
    }
  }
  return attachments.length > 0 ? attachments : undefined;
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

      const attachments = extractOverlayAttachments(lastUserMessage);

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
          ...(attachments ? { attachments } : {}),
        }),
        signal: abortSignal,
      });

      const response = responseBuilder();

      for await (const msg of parseSSEStream(res, abortSignal)) {
        if (abortSignal.aborted) break;
        if (msg.type === 'turn-complete') break;
        response.onMessage(msg);
        yield { content: response.getContent() };
      }
    },
  };
}

// ─── Exported hooks ──────────────────────────────────────────────────

/**
 * Chat adapter that uses WebSocket when connected, falls back to HTTP/SSE.
 */
export function useOverlayChatAdapter(opts: {
  overlayWs: OverlayWebSocket;
  serverUrl: string;
  token: string | null;
  sessionId: string;
  getContext: () => { documentPath?: string | null; selectedText?: string | null };
}): ChatModelAdapter {
  const getContextRef = useRef(opts.getContext);
  getContextRef.current = opts.getContext;

  return useMemo(() => {
    if (opts.overlayWs.connected) {
      return createWsChatAdapter({
        overlayWs: opts.overlayWs,
        sessionId: opts.sessionId,
        getContext: () => getContextRef.current(),
      });
    }
    return createHttpChatAdapter({
      serverUrl: opts.serverUrl,
      token: opts.token,
      sessionId: opts.sessionId,
      getContext: () => getContextRef.current(),
    });
  }, [opts.overlayWs.connected, opts.serverUrl, opts.token, opts.sessionId]);
}

/**
 * Legacy hook — delegates to WebSocket or HTTP adapter based on connection status.
 * @deprecated Use useOverlayChatAdapter instead.
 */
export function useHttpChatAdapter(opts: HttpChatAdapterOptions): ChatModelAdapter {
  const getContextRef = useRef(opts.getContext);
  getContextRef.current = opts.getContext;

  return useMemo(
    () => createHttpChatAdapter({
      ...opts,
      getContext: () => getContextRef.current(),
    }),
    [opts.serverUrl, opts.token, opts.sessionId],
  );
}

// ─── HTTP-based Thread History Adapter ─────────────────────────────────
// History always fetches via HTTP (no streaming needed).

export function useHttpHistoryAdapter(
  serverUrl: string,
  token: string | null,
  sessionId: string,
): ThreadHistoryAdapter {
  return useMemo(
    (): ThreadHistoryAdapter => ({
      async load() {
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        try {
          const res = await fetch(`${serverUrl}/api/cobuilding/sessions/${sessionId}/messages`, { headers });
          if (!res.ok) return ExportedMessageRepository.fromArray([]);
          const data = await res.json();
          const dbMessages = (data.messages ?? []) as HistoryDbMessage[];
          const messages = convertHistoryMessages(dbMessages);
          return ExportedMessageRepository.fromArray(messages);
        } catch {
          return ExportedMessageRepository.fromArray([]);
        }
      },
      async append() {},
    }),
    [serverUrl, token, sessionId],
  );
}
