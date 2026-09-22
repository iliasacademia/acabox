/**
 * How an assistant turn's parts are laid out in the thread — the pure half of
 * the collapsed-steps UI, kept free of React and `@assistant-ui/react` so it
 * runs under jest (the library is ESM-only and cannot be imported there).
 *
 * THE LAYOUT, both phases of it:
 *
 *   While the turn runs — Claude's narration stays visible, and every run of
 *   consecutive tool calls between two pieces of prose collapses to ONE line:
 *   "Ran 3 commands, wrote 2 files ›", or, while it is still going, the step in
 *   progress. That is what lets the user see what is happening now without the
 *   trail of every step taking the screen.
 *
 *   Once it ends — everything up to the final answer folds behind a single
 *   "Worked for 4m 12s · 26 steps" line, so scrolling back through old turns is
 *   compact. Expanding it restores the running-phase layout.
 *
 * Two exceptions ride outside every fold, because they are RESULTS rather than
 * process: tool calls with their own purpose-built card (a mini-app opened or
 * built, a plan prompt) and the LAST task checklist. Earlier checklists are
 * superseded snapshots and go in with the rest of the steps. Failures are never
 * hidden either — they are counted, in red, on whichever line folds them.
 */

/** The fields of a message part this module needs. Built from the runtime's part state. */
export interface PartLite {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  argsText?: string;
  /** Status type: 'running' | 'complete' | 'incomplete' | 'requires-action'. */
  status?: string;
  /** `incomplete` reason, so a cancelled step is not counted as a failure. */
  statusReason?: string;
  isError?: boolean;
  /** Text / reasoning content, for deciding whether a text part is blank. */
  text?: string;
  /**
   * Precomputed by the renderer's store selector in place of `text`/`args`,
   * which it deliberately does not copy: that selector runs on every streamed
   * token, and a Write's args can be a 75 KB file. Take precedence when set.
   */
  blank?: boolean;
  install?: boolean;
}

/**
 * Tools whose dedicated card is the outcome the user asked for. Kept to cards
 * that render something of their own; a tool with only the generic fallback
 * card is process, whatever it does.
 */
const OUTCOME_TOOLS: ReadonlySet<string> = new Set([
  'mcp__mini-apps__open_mini_application',
  'mcp__mini-apps__build_and_open_mini_application',
  'EnterPlanMode',
  'ExitPlanMode',
]);

const CHECKLIST_TOOL = 'TodoWrite';

export type Segment =
  | { kind: 'part'; index: number }
  | { kind: 'steps'; start: number; end: number };

const isBlankText = (p: PartLite): boolean =>
  p.type === 'text' && (p.blank ?? (p.text ?? '').trim() === '');

/** A part that belongs inside a run of steps rather than breaking one. */
const isStepLike = (p: PartLite): boolean =>
  p.type === 'tool-call' || p.type === 'reasoning' || isBlankText(p);

/**
 * Split parts into prose and runs of steps. A run is maximal: tool calls,
 * thinking, and blank text between them all stay in one line, because a
 * whitespace-only text part or a signature-only thinking block splitting a run
 * would put two identical-looking summary lines back to back.
 */
export function segmentParts(parts: readonly PartLite[]): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < parts.length) {
    if (!isStepLike(parts[i])) {
      out.push({ kind: 'part', index: i });
      i++;
      continue;
    }
    const start = i;
    while (i < parts.length && isStepLike(parts[i])) i++;
    out.push({ kind: 'steps', start, end: i - 1 });
  }
  return out;
}

/** Index of the last task-checklist call in the message, or -1. */
export function lastChecklistIndex(parts: readonly PartLite[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'tool-call' && parts[i].toolName === CHECKLIST_TOOL) return i;
  }
  return -1;
}

/** Whether the part at `index` renders outside any fold (see header). */
export function isOutcomePart(parts: readonly PartLite[], index: number): boolean {
  const p = parts[index];
  if (!p || p.type !== 'tool-call') return false;
  if (OUTCOME_TOOLS.has(p.toolName ?? '')) return true;
  return p.toolName === CHECKLIST_TOOL && index === lastChecklistIndex(parts);
}

export function isFailed(p: PartLite): boolean {
  if (p.type !== 'tool-call' || p.status === 'running') return false;
  if (p.isError === true) return true;
  return p.status === 'incomplete' && p.statusReason !== 'cancelled';
}

/**
 * Where the final answer starts: the first part after the last tool call.
 * Everything before it is the work; everything from it on is what the user
 * reads. `parts.length` when the turn ended on a tool call, so it all folds.
 */
export function finalAnswerStart(parts: readonly PartLite[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'tool-call') return i + 1;
  }
  return 0;
}

// ─── Summary lines ───────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function argsOf(p: PartLite): Record<string, unknown> {
  if (p.args && Object.keys(p.args).length > 0) return p.args;
  if (p.argsText) {
    try {
      const parsed = JSON.parse(p.argsText);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // Incomplete JSON while the call streams in.
    }
  }
  return {};
}

/** The install wrapper is its own kind of step, as it is on the tool card. */
export function isInstallCommand(args: Record<string, unknown> | undefined): boolean {
  return str(args?.command).trim().startsWith('.applications/install');
}

interface Category {
  key: string;
  /** Phrase for a count, e.g. n => `ran ${n} commands`. */
  phrase: (n: number) => string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? '' : ` ${n} times`);

function categoryOf(p: PartLite): Category {
  const name = p.toolName ?? '';
  switch (name) {
    case 'Bash': {
      if (p.install ?? isInstallCommand(argsOf(p))) {
        return { key: 'install', phrase: (n) => `installed ${plural(n, 'package', 'packages')}` };
      }
      return { key: 'bash', phrase: (n) => `ran ${plural(n, 'command', 'commands')}` };
    }
    case 'Read':
      return { key: 'read', phrase: (n) => `read ${plural(n, 'file', 'files')}` };
    case 'Write':
      return { key: 'write', phrase: (n) => `wrote ${plural(n, 'file', 'files')}` };
    case 'Edit':
    case 'NotebookEdit':
      return { key: 'edit', phrase: (n) => `edited ${plural(n, 'file', 'files')}` };
    case 'Grep':
    case 'Glob':
    case 'ToolSearch':
    case 'WebSearch':
      return { key: 'search', phrase: (n) => `searched${times(n)}` };
    case 'WebFetch':
      return { key: 'fetch', phrase: (n) => `fetched ${plural(n, 'page', 'pages')}` };
    case 'Agent':
      return { key: 'agent', phrase: (n) => `ran ${plural(n, 'agent', 'agents')}` };
    case 'Skill':
      return { key: 'skill', phrase: (n) => `used ${plural(n, 'skill', 'skills')}` };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return { key: 'tasks', phrase: () => 'updated tasks' };
    default: {
      const mcp = name.match(/^mcp__(.+?)__/);
      if (mcp) {
        const server = mcp[1];
        return { key: `mcp:${server}`, phrase: (n) => `called ${server}${times(n)}` };
      }
      const label = name.toLowerCase() || 'tool';
      return { key: `tool:${label}`, phrase: (n) => `used ${label}${times(n)}` };
    }
  }
}

/** Most phrases a summary line carries before the rest becomes "+N more". */
const MAX_PHRASES = 4;

/**
 * "Ran 3 commands, wrote 2 files, searched" — categories in the order they
 * first appear, since that is the order the work happened in.
 */
export function summarizeSteps(tools: readonly PartLite[]): string {
  const counts = new Map<string, { cat: Category; n: number }>();
  for (const t of tools) {
    if (t.type !== 'tool-call') continue;
    const cat = categoryOf(t);
    const entry = counts.get(cat.key);
    if (entry) entry.n++;
    else counts.set(cat.key, { cat, n: 1 });
  }
  const phrases = [...counts.values()].map(({ cat, n }) => cat.phrase(n));
  if (phrases.length === 0) return '';
  const shown = phrases.slice(0, MAX_PHRASES);
  if (phrases.length > MAX_PHRASES) shown.push(`+${phrases.length - MAX_PHRASES} more`);
  const joined = shown.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** "4m 12s", "38s", "1h 3m". Never fabricated: callers pass null when unknown. */
export function formatWorkedFor(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** The collapsed line for a finished turn: "Worked for 4m 12s · 26 steps". */
export function turnFoldLabel(stepCount: number, workedMs: number | null): string {
  const steps = plural(stepCount, 'step', 'steps');
  return workedMs != null && workedMs > 0
    ? `Worked for ${formatWorkedFor(workedMs)} · ${steps}`
    : `Worked · ${steps}`;
}
