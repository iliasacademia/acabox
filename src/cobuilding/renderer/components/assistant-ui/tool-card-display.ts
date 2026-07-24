/**
 * Maps a tool call (name + args) to the instrument-readout display triple:
 * Material Symbols icon, short mono name, and the key-args string shown in
 * the card row. Spec: Phase B README § Tool-call cards.
 */

export interface ToolCardDisplay {
  /** Material Symbols ligature name. */
  icon: string;
  /** Short mono label, e.g. "bash", "write", "app". */
  name: string;
  /** Key arguments, pre-truncated by CSS ellipsis. */
  args: string;
}

export function resolveToolArgs(
  args: Record<string, unknown> | undefined,
  argsText?: string,
): Record<string, unknown> | undefined {
  if (args && Object.keys(args).length > 0) return args;
  if (argsText) {
    try {
      const parsed = JSON.parse(argsText);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // argsText is incomplete JSON while streaming
    }
  }
  return undefined;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function getToolCardDisplay(
  toolName: string,
  args: Record<string, unknown> | undefined,
  argsText?: string,
): ToolCardDisplay {
  const a = resolveToolArgs(args, argsText) ?? {};

  switch (toolName) {
    case 'Bash': {
      const cmd = str(a.command).replace(/\s+/g, ' ').trim();
      // The install wrapper is its own instrument: `install pip <pkg> …`
      if (cmd.startsWith('.applications/install')) {
        return { icon: 'download', name: 'install', args: cmd.replace(/^\.applications\/install\s*/, '') };
      }
      return { icon: 'terminal', name: 'bash', args: cmd || str(a.description) };
    }
    case 'Read':
      return { icon: 'description', name: 'read', args: str(a.file_path) };
    case 'Write':
      return { icon: 'edit', name: 'write', args: str(a.file_path) };
    case 'Edit':
      return { icon: 'edit', name: 'edit', args: str(a.file_path) };
    case 'NotebookEdit':
      return { icon: 'edit', name: 'notebook', args: str(a.notebook_path) };
    case 'Glob':
      return { icon: 'search', name: 'glob', args: str(a.pattern) };
    case 'Grep':
      return { icon: 'search', name: 'grep', args: str(a.pattern) };
    case 'WebSearch':
      return { icon: 'search', name: 'web', args: str(a.query) };
    case 'WebFetch':
      return { icon: 'language', name: 'fetch', args: str(a.url) };
    case 'Agent':
      return { icon: 'smart_toy', name: 'agent', args: str(a.description) || str(a.prompt) };
    case 'Skill':
      return { icon: 'bolt', name: 'skill', args: str(a.skill) };
    case 'TodoWrite':
      return { icon: 'checklist', name: 'todo', args: '' };
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { icon: 'map', name: 'plan', args: '' };
    case 'mcp__mini-apps__open_mini_application':
      return { icon: 'deployed_code', name: 'app', args: str(a.dir_name) };
    case 'mcp__mini-apps__build_and_open_mini_application':
      return { icon: 'deployed_code', name: 'app', args: str(a.dir_name) };
    case 'mcp__workspace__get_scanned_files':
      return { icon: 'folder_open', name: 'workspace', args: str(a.file_type) || 'scanned files' };
    case 'mcp__workspace__get_research_profile':
      return { icon: 'folder_open', name: 'workspace', args: 'research profile' };
    default: {
      // MCP tools: mcp__server__tool → "server" + tool as args; anything
      // else falls back to the raw tool name.
      const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) {
        return { icon: 'extension', name: mcp[1], args: mcp[2].replace(/_/g, ' ') };
      }
      return { icon: 'build', name: toolName.toLowerCase(), args: '' };
    }
  }
}

/** Normalizes a tool result (string | content blocks | JSON) to display text. */
export function toolResultToText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const texts = result
      .map((b: any) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : null))
      .filter((t): t is string => t !== null);
    if (texts.length > 0) return texts.join('\n');
  }
  if (typeof result === 'object' && typeof (result as any).text === 'string') {
    return (result as any).text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** "4S" / "1M 12S" for the card's right meta. */
export function formatToolSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}S`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}M ${secs}S`;
}
