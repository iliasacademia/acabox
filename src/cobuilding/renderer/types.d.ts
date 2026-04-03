import type { ChatAPI } from '../shared/types';

interface SessionData {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageData {
  id: number;
  session_id: string;
  type: string;
  content: string;
  created_at: string;
}

interface SessionsAPI {
  list(): Promise<SessionData[]>;
  get(id: string): Promise<SessionData | undefined>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  listMessages(sessionId: string): Promise<MessageData[]>;
}

declare global {
  interface Window {
    chatAPI: ChatAPI;
    sessionsAPI: SessionsAPI;
    electronAPI: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      on: (channel: string, callback: (...args: any[]) => void) => void;
      removeListener: (channel: string, callback: (...args: any[]) => void) => void;
    };
  }
}
