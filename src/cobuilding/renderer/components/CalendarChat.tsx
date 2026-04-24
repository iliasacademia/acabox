import React from 'react';
import { useLocalRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import { Thread } from './assistant-ui/thread';
import { useCalendarChatAdapter } from '../calendarChatAdapter';
import { useCalendarHistoryAdapter } from '../calendarHistoryAdapter';
import './CalendarChat.css';

export function CalendarChat() {
  const chatAdapter = useCalendarChatAdapter();
  const history = useCalendarHistoryAdapter();
  const runtime = useLocalRuntime(chatAdapter, { adapters: { history } });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="calendarChatThread">
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}
