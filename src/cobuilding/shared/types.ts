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

export interface ChatAPI {
  sendMessage(threadId: string, text: string): ChatMessageStream;
}

export interface Workspace {
  id: string;
  name: string;
  directory_path: string;
  api_key: string;
  created_at: string;
  updated_at: string;
}
