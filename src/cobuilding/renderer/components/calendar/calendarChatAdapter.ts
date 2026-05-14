import { useMemo } from 'react';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { responseBuilder, toAsyncIterable } from '../../chatAdapter';
import { resetProgress } from '../../progressStore';

const THREAD_ID = 'calendar-assistant';

export function useCalendarChatAdapter(): ChatModelAdapter {
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

        const { stream, release } = window.chatAPI.sendMessage(THREAD_ID, userText);
        const responseStream = toAsyncIterable(stream);

        const response = responseBuilder();
        resetProgress();

        const onAbort = () => window.chatAPI.stopResponding(THREAD_ID);
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
          release();
        }
      },
    }),
    [],
  );
}
