/**
 * Rendering a stored chat back into prose another agent can read.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT DROPS MOST OF THE ROWS
 * --------------------------------------------------------
 * Measured against the real production database (13 chats, 2026-09-17):
 *
 *     whole record                 12 MB
 *       tool_result rows          7.7 MB   (64%)
 *       assistant rows            4.3 MB
 *       user rows                  53 KB
 *     largest single chat         7.4 MB over 1,211 rows
 *       …its conversation          54 KB   (2.6 KB typed, 52 KB replies)
 *
 * So the conversation is roughly 0.7% of what is stored, and the other 99.3%
 * is tool plumbing: file contents that were read, grep output, command
 * transcripts. Drop that and every chat this user has ever had fits in a
 * context window whole — the largest is ~67 KB, about 17k tokens. Keep it and
 * a single `read_chat` could exceed the window on its own.
 *
 * That measurement is the whole design. There is no summarisation pipeline,
 * no embedding index and no chunking strategy, because at these sizes none of
 * them buys anything: strip the plumbing and the problem disappears. The
 * budget below is a backstop for a pathological thread, not the normal path.
 *
 * Tool CALLS are kept as one line each (`[Read: /path/x.md]`) while tool
 * OUTPUT is dropped by default. The asymmetry is deliberate: knowing that the
 * other thread grepped for a string, or ran a particular query, is most of the
 * value and costs ~60 characters, whereas the output it produced is the 7.7 MB
 * and is usually reproducible by just running the thing again.
 *
 * Pure functions over row-shaped input, with no database import, so they can
 * be tested directly against rows lifted out of the real schema.
 */

/** The subset of a `messages` row this module needs. */
export interface TranscriptRow {
  type: string;
  content: string;
  created_at?: string;
}

export interface RenderChatOptions {
  /** Ceiling on the rendered output. Defaults to DEFAULT_READ_CHARS. */
  maxChars?: number;
  /** Include an excerpt of each tool's output. Off by default — see above. */
  includeToolOutput?: boolean;
}

export interface RenderedChat {
  text: string;
  /** Conversation blocks in the chat (one per speaker turn). */
  totalBlocks: number;
  /** Blocks dropped to stay inside the budget. */
  elidedBlocks: number;
}

/**
 * Default ceiling, ~15k tokens.
 *
 * Chosen from the measurement above: the largest real conversation is ~67 KB,
 * so this covers essentially every thread whole while capping the worst case
 * at something a turn can absorb without crowding out the work it was asked
 * to do.
 */
export const DEFAULT_READ_CHARS = 60_000;

/** Hard ceiling even when a caller asks for more. ~30k tokens. */
export const MAX_READ_CHARS = 120_000;

/** Per-tool-result excerpt when output is explicitly requested. */
const TOOL_OUTPUT_EXCERPT_CHARS = 400;

/** Per-tool-call argument excerpt. */
const TOOL_ARG_CHARS = 160;

/** Smallest useful share of the budget for one turn. Below this a turn says
 *  nothing, so dropping turns becomes the better trade. */
const MIN_BLOCK_CHARS = 400;

/** Room reserved for the "characters trimmed" marker inside a cut turn. */
const TRIM_MARKER_BUDGET = 48;

/** Room reserved for the "N messages omitted" marker between the two ends. */
const ELIDE_MARKER_BUDGET = 120;

const BLOCK_SEP = '\n\n';

/**
 * Argument names worth showing, most informative first.
 *
 * A tool call's identity is usually carried by one field — the path for
 * `Read`, the pattern for `Grep`, the command for `Bash` — and printing the
 * whole input object instead would reintroduce the bloat this module exists to
 * remove. Ordered rather than per-tool-name so an MCP tool nobody anticipated
 * still prints something useful.
 */
const ARG_PRIORITY = [
  'command', 'file_path', 'notebook_path', 'path', 'pattern', 'query',
  'url', 'prompt', 'description', 'title', 'name', 'id',
];

function oneLine(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ARG_PRIORITY) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return oneLine(v, TOOL_ARG_CHARS);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) return `${k}=${oneLine(v, TOOL_ARG_CHARS)}`;
  }
  return '';
}

function safeParse(content: string): unknown {
  try { return JSON.parse(content); } catch { return null; }
}

/**
 * Flatten a `tool_result` block's content, which the SDK writes either as a
 * plain string or as an array of content blocks.
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

interface Block { speaker: 'You' | 'Claude'; parts: string[] }

function renderUserRow(content: string): string[] {
  const parsed = safeParse(content);
  const parts: string[] = [];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    // A quoted excerpt was part of what the user actually said, so it belongs
    // in the transcript — the typed text often does not stand alone without it
    // ("is this right?" above a pasted block means nothing by itself).
    const quote = obj.quote as { text?: unknown } | undefined;
    if (quote && typeof quote.text === 'string' && quote.text) {
      parts.push(quote.text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    }
    if (typeof obj.text === 'string' && obj.text.trim()) parts.push(obj.text.trim());
    const attachments = obj.attachments;
    if (Array.isArray(attachments) && attachments.length) {
      const names = attachments
        .map((a) => (a && typeof a === 'object' ? (a as any).name ?? (a as any).path : null))
        .filter((n): n is string => typeof n === 'string');
      if (names.length) parts.push(`(attached: ${names.join(', ')})`);
    }
  } else if (content.trim()) {
    // A row written before the JSON envelope existed, or by another writer.
    parts.push(content.trim());
  }
  return parts;
}

function renderAssistantRow(content: string): string[] {
  const parsed = safeParse(content);
  if (!Array.isArray(parsed)) return content.trim() ? [content.trim()] : [];
  const parts: string[] = [];
  for (const block of parsed) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      parts.push(b.text.trim());
    } else if (b.type === 'tool_use') {
      // `thinking` blocks are skipped entirely on the way past. They are
      // mostly empty in the stored rows and carry a multi-kilobyte `signature`
      // field that is pure noise to a reader.
      const name = typeof b.name === 'string' ? b.name : 'tool';
      const arg = summarizeToolInput(b.input);
      parts.push(arg ? `[${name}: ${arg}]` : `[${name}]`);
    }
  }
  return parts;
}

function renderToolResultRow(content: string): string[] {
  const parsed = safeParse(content);
  if (!Array.isArray(parsed)) return [];
  const parts: string[] = [];
  for (const block of parsed) {
    if (!block || typeof block !== 'object') continue;
    const text = toolResultText((block as any).content);
    if (!text.trim()) continue;
    parts.push(`  → ${oneLine(text, TOOL_OUTPUT_EXCERPT_CHARS)}`);
  }
  return parts;
}

/**
 * Render stored rows into a readable conversation.
 *
 * Consecutive assistant/tool rows are merged into one `Claude` block because
 * the database writes one row per streamed message — a single reply that calls
 * three tools is four rows, and rendering each as its own speaker turn makes a
 * coherent answer look like a stutter.
 */
export function renderChatTranscript(
  rows: TranscriptRow[],
  options: RenderChatOptions = {},
): RenderedChat {
  const maxChars = Math.min(options.maxChars ?? DEFAULT_READ_CHARS, MAX_READ_CHARS);
  const blocks: Block[] = [];

  const appendToClaude = (parts: string[]) => {
    if (!parts.length) return;
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === 'Claude') last.parts.push(...parts);
    else blocks.push({ speaker: 'Claude', parts: [...parts] });
  };

  for (const row of rows) {
    if (row.type === 'user') {
      const parts = renderUserRow(row.content);
      if (parts.length) blocks.push({ speaker: 'You', parts });
    } else if (row.type === 'assistant') {
      appendToClaude(renderAssistantRow(row.content));
    } else if (row.type === 'tool_result') {
      if (options.includeToolOutput) appendToClaude(renderToolResultRow(row.content));
    } else if (row.type === 'result') {
      const parsed = safeParse(row.content) as { is_error?: unknown } | null;
      if (parsed && parsed.is_error === true) appendToClaude(['[this turn ended with an error]']);
    }
  }

  const rendered = blocks.map((b) => `## ${b.speaker}\n${b.parts.join('\n\n')}`);
  const total = rendered.length;
  if (!total) return { text: '(this chat has no messages yet)', totalBlocks: 0, elidedBlocks: 0 };

  const joined = rendered.join(BLOCK_SEP);
  if (joined.length <= maxChars) {
    return { text: joined, totalBlocks: total, elidedBlocks: 0 };
  }

  // Over budget. TRIM LONG TURNS RATHER THAN DROPPING TURNS, which is the
  // opposite of what this did first and was corrected by measurement: against
  // the real "Hex HTTP 403" chat, dropping whole blocks discarded 26 of 50
  // exchanges to save 7 KB, because block sizes are wildly uneven — one reply
  // carrying forty tool-call lines can consume the entire head budget on its
  // own. A reader handed half a conversation cannot tell that the missing half
  // existed, and will summarise what is left as if it were the whole thing.
  //
  // So: every turn survives, and the long ones are cut. The cap per turn is
  // water-filled — raise a single ceiling until the total fits, so short turns
  // are untouched and only the genuinely long ones pay. Dropping turns is the
  // fallback for a chat so long that even a floor-sized share of the budget
  // does not go round, and then it is reported.
  const sepCost = (n: number) => BLOCK_SEP.length * Math.max(0, n - 1);

  // Try to keep EVERY turn first, and only consider dropping turns if the
  // resulting per-turn cap would be too small to say anything. Reserving a
  // floor per turn up front was the first attempt and it was wrong: turns are
  // mostly short ("question 7" is twenty characters), so a 400-character
  // reservation per turn discarded 31 of 80 exchanges to protect space that
  // would never have been used. Water-filling already handles unequal sizes.
  let kept = rendered;
  let elided = 0;
  let headCount = 0;
  let cap = waterFillCap(kept.map((b) => b.length), maxChars - sepCost(kept.length));

  if (cap < MIN_BLOCK_CHARS) {
    // Genuinely too many turns for the budget. Keep both ends and say how
    // many went: the tail gets the larger share because a reference is usually
    // made to something that was settled, but the opening carries the question
    // the thread exists to answer, so it is never dropped entirely.
    const keepCount = Math.max(2, Math.min(total, Math.floor(maxChars / (MIN_BLOCK_CHARS + BLOCK_SEP.length))));
    headCount = Math.max(1, Math.floor(keepCount * 0.35));
    const tailCount = keepCount - headCount;
    kept = [...rendered.slice(0, headCount), ...rendered.slice(total - tailCount)];
    elided = total - keepCount;
    cap = waterFillCap(
      kept.map((b) => b.length),
      maxChars - sepCost(kept.length + 1) - ELIDE_MARKER_BUDGET,
    );
  }

  const trimmed = kept.map((b) => truncateBlock(b, cap));
  const text = elided
    ? [
      ...trimmed.slice(0, headCount),
      `[… ${elided} message${elided === 1 ? '' : 's'} from the middle of this chat omitted. `
        + 'Raise max_chars to see them. …]',
      ...trimmed.slice(headCount),
    ].join(BLOCK_SEP)
    : trimmed.join(BLOCK_SEP);

  return { text, totalBlocks: total, elidedBlocks: elided };
}

/**
 * The single per-turn ceiling that makes the whole transcript fit.
 *
 * Binary search for the largest cap where the sum of `min(length, cap)` stays
 * inside the budget. A turn shorter than the cap is untouched, so the cost of
 * one rambling reply is never paid by the twenty short exchanges around it.
 */
function waterFillCap(lengths: number[], budget: number): number {
  if (!lengths.length) return 0;
  let lo = 0;
  let hi = Math.max(...lengths);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    let sum = 0;
    for (const len of lengths) sum += Math.min(len, mid);
    if (sum <= budget) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Cut one over-long turn down to `cap`, keeping its speaker heading, the
 * opening of what was said and the end of it. Head and tail for the same
 * reason the whole transcript keeps both ends: a long reply usually states
 * what it is about at the top and what it concluded at the bottom, and the
 * tool-call middle is the part that can be inferred.
 */
function truncateBlock(rendered: string, cap: number): string {
  if (rendered.length <= cap) return rendered;
  const nl = rendered.indexOf('\n');
  const heading = nl === -1 ? rendered.slice(0, 16) : rendered.slice(0, nl);
  const body = nl === -1 ? rendered.slice(16) : rendered.slice(nl + 1);

  const room = cap - heading.length - 1 - TRIM_MARKER_BUDGET;
  if (room <= 0) return `${heading}\n[… this message omitted to stay inside the character budget …]`;

  const headLen = Math.floor(room * 0.6);
  const tailLen = room - headLen;
  // Prefer a line boundary so the excerpt does not stop mid-sentence, but
  // never give up more than a fifth of the allowance to that preference.
  const rawHead = body.slice(0, headLen);
  const breakAt = rawHead.lastIndexOf('\n');
  const head = breakAt > headLen * 0.8 ? rawHead.slice(0, breakAt) : rawHead;
  const tail = body.slice(body.length - tailLen);
  const cut = body.length - head.length - tail.length;

  return `${heading}\n${head}\n[… ${cut.toLocaleString('en-US')} characters trimmed …]\n${tail}`;
}

/**
 * A readable excerpt around the first case-insensitive occurrence of `needle`,
 * for a search result line. Returns null when the needle is not in the text.
 */
export function excerptAround(text: string, needle: string, radius = 110): string | null {
  if (!needle) return null;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

/**
 * The plain text of a stored row, for search snippets only.
 *
 * Distinct from the transcript renderer: this one wants the words a human
 * wrote or read, with no speaker headings or tool-call brackets, so a match
 * lands on prose rather than on markup this module itself added.
 */
export function rowPlainText(row: TranscriptRow): string {
  if (row.type === 'user') return renderUserRow(row.content).join('\n');
  if (row.type === 'assistant') return renderAssistantRow(row.content).join('\n');
  return '';
}
