import type { createSdkMcpServer, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { WindowState } from '../../../windowMonitor/types';

export type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;

export type PreToolUseHook = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<SyncHookJSONOutput>;

export interface ApplyEditParams {
  toolCallId?: string;
  document_path?: string;
  search_text: string;
  replacement_text: string;
  replace_scope?: 'first' | 'all';
  match_case?: boolean;
}

export interface ApplyEditResult {
  success: boolean;
  error?: string;
  replacementsCount?: number;
}

export interface MessagePrefixContext {
  documentPath?: string;
  selectedText?: string;
}

export interface HostApp {
  /** Stable identifier for this host app. */
  id: 'word' | 'obsidian' | 'apple-notes';

  /** macOS bundle ID — used by window-monitor and to match window events. */
  bundleId: string;

  /** Display name shown in UI labels and prompt text. */
  displayName: string;

  /** File extensions this host app owns (lowercase, with leading dot). */
  fileExtensions: string[];

  /** Args to spawn the window-monitor binary for this host. */
  windowMonitorArgs(): string[];

  /**
   * Resolve the active document path for a window owned by this host app.
   * Word: returns the AX-populated documentPath as-is.
   * Obsidian: parses window title against the workspace dir.
   * Return null when no active document can be resolved.
   */
  resolveDocumentPath(window: WindowState, workspaceDir: string | null): string | null;

  /** Identifier used as the key when registering the MCP server with the SDK. */
  mcpServerKey: string;

  /** Build the MCP server for this host. workspaceDir lets the host scope filesystem ops. */
  createMcpServer(workspaceDir: string): SdkMcpServer;

  /** Allowed-tool names contributed by this host (e.g. ['mcp__ms-word__get_text', ...]). */
  allowedTools: string[];

  /** PreToolUse hooks contributed by this host (e.g. Word's docx-protection hook). */
  preToolHooks?: PreToolUseHook[];

  /** Host-specific guidance appended to the shared identity preamble in the system prompt. */
  systemPromptAppend: string;

  /**
   * Prefix injected into the user message by the messagePreprocessor when sending to the agent.
   * Returns an empty string when no host context applies.
   */
  messagePrefix(ctx: MessagePrefixContext): string;

  /** Apply a user-approved find/replace edit. Word: AppleScript. Obsidian: filesystem. */
  applyEdit(params: ApplyEditParams): Promise<ApplyEditResult>;

  /**
   * Optional SQL-LIKE pattern matching `sessions.document_path` values that
   * belong to this host. When the active document path can't be resolved
   * (e.g. Apple Notes with no selection), `buildOverlayPollResponseV2` uses
   * this to show every chat for the host instead of an empty list.
   * Word/Obsidian leave it unset — their per-document filter is enough.
   */
  sessionDocumentPathLikePattern?: string;

  /** Optional pre/post hooks around applyEdit (e.g. Word's selection-event suppression). */
  onApplyEditWillRun?(): void;
  onApplyEditDidRun?(): void;
}
