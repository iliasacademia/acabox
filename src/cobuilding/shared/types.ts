export type ChatStreamMessage =
  // Completed messages
  | { type: 'text'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      argsText: string;
    }
  | {
      type: 'tool-result';
      toolCallId: string;
      result: unknown;
      isError?: boolean;
    }
  // Streaming deltas
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; toolCallId: string; toolName: string }
  | { type: 'tool-call-args-delta'; toolCallId: string; argsText: string }
  | { type: 'tool-call-end'; toolCallId: string }
  // Thinking
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-end' }
  // Tool progress
  | { type: 'tool-progress'; toolCallId: string; toolName: string; elapsedSeconds: number }
  // Subagent progress
  | { type: 'subagent-started'; taskId: string; parentToolCallId: string; description: string }
  | { type: 'subagent-progress'; taskId: string; parentToolCallId: string; summary?: string; lastToolName?: string; toolUseCount: number; durationMs: number }
  | { type: 'subagent-done'; taskId: string; parentToolCallId: string; status: 'completed' | 'failed' | 'stopped'; summary: string };

export interface ChatMessageStream {
  next(): Promise<{ value: ChatStreamMessage | null; done: boolean }>;
}

export type IPCAttachment =
  | { type: 'image'; data: string; mediaType: string; name?: string }
  | { type: 'document'; data: string; mediaType: string; title?: string; name?: string };

export interface ChatSubscription {
  stream: ChatMessageStream;
  /** Closes the local stream and stops consuming events. The main-process forwarding
   *  listener is left alive and cleaned up by the session's own lifecycle (onDone/onError),
   *  so chatAdapter's stream is never starved by an early unsubscribe. */
  unsubscribe: () => void;
}

export interface ChatAPI {
  sendMessage(threadId: string, text: string, attachments?: IPCAttachment[]): ChatMessageStream;
  subscribe(threadId: string): ChatSubscription;
  stopResponding(threadId: string): void;
  onQuickChatInject(callback: (data: { text: string; context: any }) => void): () => void;
}

export interface Workspace {
  id: string;
  name: string;
  directory_path: string;
  api_key: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

export interface ScheduledTask {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  prompt: string;
  cron_expression: string;
  enabled: number;
  session_source: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  session_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface CreateTaskData {
  name: string;
  description: string;
  prompt: string;
  cron_expression: string;
  session_source?: string;
}

export interface UpdateTaskData {
  name?: string;
  description?: string;
  prompt?: string;
  cron_expression?: string;
  enabled?: number;
  session_source?: string;
}

export type NotificationNavigationAction =
  | { type: 'thread'; threadId: string; sidebarTab?: 'chats' | 'files' | 'apps' | 'scheduled' | 'reactions' | 'debug' }
  | { type: 'sidebar'; tab: 'chats' | 'files' | 'apps' | 'scheduled' | 'reactions' | 'debug' };
