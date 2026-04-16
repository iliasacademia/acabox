import { useMemo } from 'react';
import type { ChatModelAdapter } from '@assistant-ui/react';
import type { ChatMessageStream } from '../shared/types';
import { responseBuilder, toAsyncIterable } from './chatAdapter';
import { resetProgress } from './progressStore';

export function useNotesChatAdapter(dayFile: string): ChatModelAdapter {
  const threadId = `notes-assistant-${dayFile}`;

  return useMemo(
    (): ChatModelAdapter => ({
      async *run({ messages, abortSignal }) {
        const lastUserMessage = messages.filter((m) => m.role === 'user').pop();
        if (!lastUserMessage) return;

        const userText = lastUserMessage.content
          .filter(
            (part): part is { type: 'text'; text: string } => part.type === 'text',
          )
          .map((part) => part.text)
          .join('');

        const responseStream = toAsyncIterable(
          window.chatAPI.sendMessage(threadId, userText) as ChatMessageStream,
        );

        const response = responseBuilder();
        resetProgress();

        const onAbort = () => window.chatAPI.stopResponding(threadId);
        abortSignal.addEventListener('abort', onAbort, { once: true });

        try {
          for await (const msg of responseStream) {
            if (abortSignal.aborted) break;
            response.onMessage(msg);
            yield { content: response.getContent() };
          }
        } finally {
          abortSignal.removeEventListener('abort', onAbort);
          resetProgress();
        }
      },
    }),
    [threadId],
  );
}
