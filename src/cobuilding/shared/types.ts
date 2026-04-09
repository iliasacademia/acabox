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
  | { type: 'tool-call-end'; toolCallId: string };

export interface ChatMessageStream {
  next(): Promise<{ value: ChatStreamMessage | null; done: boolean }>;
}

export type IPCAttachment =
  | { type: 'image'; data: string; mediaType: string; name?: string }
  | { type: 'document'; data: string; mediaType: string; title?: string; name?: string };

export interface ChatAPI {
  sendMessage(threadId: string, text: string, attachments?: IPCAttachment[]): ChatMessageStream;
  onQuickChatInject(callback: (data: { text: string; context: any }) => void): () => void;
}

export interface Workspace {
  id: string;
  name: string;
  directory_path: string;
  api_key: string;
  created_at: string;
  updated_at: string;
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
