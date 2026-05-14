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
  | { type: 'subagent-done'; taskId: string; parentToolCallId: string; status: 'completed' | 'failed' | 'stopped'; summary: string }
  // Heartbeat — signals the agent is still alive during long operations
  | { type: 'heartbeat' }
  // Status — changes the processing indicator label (e.g., "Agent initializing..." vs "Processing")
  | { type: 'status'; status: string }
  // Turn complete — the agent finished this turn's response. Unlike chat:done
  // (which kills the stream iterator), this is a regular event that the
  // chatAdapter uses to break from its loop while keeping the stream alive.
  // `messageId` correlates back to the user turn that prompted this response;
  // null for legacy turns that started before the messageId plumbing landed.
  | { type: 'turn-complete'; messageId?: string }
  // Cross-surface user message — emitted server-side right after a user
  // message is inserted into the DB, so subscribers on OTHER surfaces
  // (the desktop chat when the overlay sent it, or vice versa) can refresh
  // and show the user turn before the assistant streams. Without this, the
  // assistant's reply lands via the existing fanout but the prompting user
  // turn stays missing on the non-originating surface.
  | { type: 'user-message'; text: string; messageId?: string };

export interface ChatMessageStream {
  next(): Promise<{ value: ChatStreamMessage | null; done: boolean }>;
}

export type IPCAttachment =
  | { type: 'image'; data: string; mediaType: string; name?: string }
  | { type: 'document'; data: string; mediaType: string; title?: string; name?: string }
  | { type: 'file_reference'; filePath: string; name: string };

export interface ChatSubscription {
  stream: ChatMessageStream;
  /** Closes the local stream and stops consuming events. The main-process forwarding
   *  listener is left alive and cleaned up by the session's own lifecycle (onDone/onError),
   *  so chatAdapter's stream is never starved by an early unsubscribe. */
  unsubscribe: () => void;
}

export interface ChatAPI {
  sendMessage(threadId: string, text: string, attachments?: IPCAttachment[], model?: string, documentPath?: string, messageId?: string): ChatMessageStream;
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
  | { type: 'thread'; threadId: string; sidebarTab?: 'home' | 'tools' | 'files' | 'chats' | 'debug' | 'settings' }
  | { type: 'sidebar'; tab: 'home' | 'tools' | 'files' | 'chats' | 'debug' | 'settings' };

// ---- Calendar ----

export interface CalendarGroup {
  id: string;
  workspace_id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: string;
  workspace_id: string;
  group_id: string | null;
  name: string;
  start_at: string;
  end_at: string;
  status: 'active' | 'inactive' | 'inactive_hidden';
  color: string | null;
  recurrence_rule: string | null;
  recurrence_parent_id: string | null;
  recurrence_exception_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventFile {
  id: number;
  event_id: string;
  file_path: string;
  created_at: string;
}

export interface GroupFile {
  id: number;
  group_id: string;
  file_path: string;
  created_at: string;
}

export type CalendarResourceType = 'file' | 'link' | 'note' | 'folder';

export interface CalendarResource {
  id: string;
  workspace_id: string;
  type: CalendarResourceType;
  event_id: string | null;
  group_id: string | null;
  parent_id: string | null;
  file_path: string | null;
  url: string | null;
  note_content: string | null;
  title: string;
  sort_order: number;
  ai_generated: number;
  created_at: string;
  updated_at: string;
}

export interface CreateResourceData {
  type: CalendarResourceType;
  event_id?: string | null;
  group_id?: string | null;
  parent_id?: string | null;
  file_path?: string | null;
  url?: string | null;
  note_content?: string | null;
  title?: string;
  sort_order?: number;
  ai_generated?: boolean;
}

export interface UpdateResourceData {
  title?: string;
  url?: string;
  note_content?: string;
  file_path?: string;
}

export interface MoveResourceData {
  group_id?: string | null;
  event_id?: string | null;
  parent_id?: string | null;
  sort_order?: number;
}

export interface ListResourcesOptions {
  event_id?: string;
  group_id?: string;
  parent_id?: string | null;
  standalone?: boolean;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: WorkspaceFileEntry[];
}

export interface CreateGroupData {
  name: string;
  color: string;
}

export interface UpdateGroupData {
  name?: string;
  color?: string;
}

export interface CreateEventData {
  group_id?: string | null;
  name: string;
  start_at: string;
  end_at: string;
  status?: 'active' | 'inactive' | 'inactive_hidden';
  color?: string | null;
  recurrence_rule?: string | null;
  recurrence_parent_id?: string | null;
  recurrence_exception_date?: string | null;
}

export interface UpdateEventData {
  group_id?: string | null;
  name?: string;
  start_at?: string;
  end_at?: string;
  status?: 'active' | 'inactive' | 'inactive_hidden';
  color?: string | null;
  recurrence_rule?: string | null;
}

export interface EventDependency {
  id: string;
  predecessor_id: string;
  successor_id: string;
  lag_min_ms: number;
  lag_max_ms: number | null;
  lag_current_ms: number;
  created_at: string;
  updated_at: string;
}

export interface CreateDependencyData {
  predecessor_id: string;
  successor_id: string;
  lag_min_ms?: number;
  lag_max_ms?: number | null;
  lag_current_ms?: number;
}

export interface UpdateDependencyData {
  lag_min_ms?: number;
  lag_max_ms?: number | null;
  lag_current_ms?: number;
}

export interface CascadeUpdate {
  eventId: string;
  newStartAt: string;
  newEndAt: string;
}


