/**
 * Quote-to-composer: selecting text anywhere in Acabox and carrying that
 * excerpt into the next chat message.
 *
 * This module is the single source of truth for the three things that must
 * agree across the renderer, main, and the persisted row: the shape of a
 * quote, the ceiling on how much text one can carry, and how a quote is
 * composed into the text the agent actually receives.
 *
 * WHY A SHARED MODULE AND NOT THE LIBRARY'S TYPE
 * ----------------------------------------------
 * `@assistant-ui/react` ships a quote slot on the composer, and its own
 * `QuoteInfo` is `{ text, messageId }`. That is enough for quoting chat prose
 * and nothing else: a spreadsheet cell, a log line, or a selection inside a
 * mini-app iframe has no message id, and an excerpt with no stated origin is
 * one the agent has to re-derive the context for. `AcaboxQuote` is a superset
 * carrying provenance, and it rides through the library unchanged — `setQuote`
 * writes its argument verbatim into the outgoing message's
 * `metadata.custom.quote`, and `custom` is untyped. That is what lets the
 * optimistic bubble and the rehydrated-from-SQLite bubble render through one
 * code path.
 */

/** Where an excerpt came from. Drives both the chip label and the attribution
 *  line the agent sees. */
export type QuoteSource =
  /** Chat prose: an assistant reply, a user message, or a thinking block. */
  | { kind: 'message'; role: 'user' | 'assistant' | 'reasoning' }
  /** The rendered body of a tool-call card. */
  | { kind: 'tool'; toolName: string }
  /** A file surface in the host renderer: Files tab, file viewer, spreadsheet. */
  | { kind: 'file'; path: string }
  /** Inside a mini-app's `local-file://` iframe. */
  | { kind: 'miniapp'; appDirName: string; appName: string };

export interface AcaboxQuote {
  /** The excerpt, already capped. Never longer than MAX_QUOTE_CHARS. */
  text: string;
  /** True when the user's selection was longer than the cap. */
  truncated: boolean;
  /**
   * The library's anchor. A real message id for chat prose; a synthetic
   * `src:<kind>:…` string otherwise, since the library only ever treats this
   * as an opaque token and requiring a real one would exclude every non-chat
   * surface.
   */
  messageId: string;
  source: QuoteSource;
}

/**
 * Ceiling on the excerpt carried into a turn — roughly 2,000 tokens.
 *
 * This is not a guardrail against a careless user, it is a guardrail against a
 * failure this app has already suffered once: a single inlined 39,335-row CSV
 * produced a 5.5 MB transcript, and because every turn resumes that transcript
 * the thread was rejected with "Prompt is too long" forever after, including on
 * a bare "Hi". Quoting is a new path to the identical outcome — a rendered
 * spreadsheet or a Debug log is one Cmd-A away from megabytes of selection —
 * so the excerpt is capped before it can ever reach a transcript.
 *
 * Truncation is never silent: `truncated` is set, the excerpt ends in an
 * ellipsis, and the attribution line says so, so neither the user nor the model
 * is misled about having seen the whole of something.
 */
export const MAX_QUOTE_CHARS = 8_000;

/** Longest source label we will render or send, so a pathological path or tool
 *  name cannot itself become the payload. */
const MAX_LABEL_CHARS = 200;

/**
 * Normalize and cap a raw DOM selection.
 *
 * Collapses the trailing whitespace a drag-selection usually picks up, then
 * cuts at the cap. Returns null for a selection that is empty once trimmed —
 * the caller should show no toolbar at all rather than an inert one.
 */
export function prepareQuoteText(raw: string): { text: string; truncated: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_QUOTE_CHARS) return { text: trimmed, truncated: false };
  // Cut at the last whitespace inside the budget so the excerpt does not end
  // mid-word, but never lose more than the last 10% to that preference.
  const hard = trimmed.slice(0, MAX_QUOTE_CHARS);
  const lastBreak = hard.lastIndexOf(' ');
  const cut = lastBreak > MAX_QUOTE_CHARS * 0.9 ? hard.slice(0, lastBreak) : hard;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

/**
 * Human-readable origin, used verbatim in the composer chip and in the
 * attribution line sent to the agent.
 */
export function describeQuoteSource(source: QuoteSource): string {
  let label: string;
  switch (source.kind) {
    case 'message':
      label = source.role === 'assistant'
        ? 'your earlier reply'
        : source.role === 'reasoning'
          ? 'your thinking'
          : 'my earlier message';
      break;
    case 'tool':
      label = `the ${source.toolName} tool output`;
      break;
    case 'file':
      label = source.path;
      break;
    case 'miniapp':
      label = `the ${source.appName} tool`;
      break;
    default: {
      // Exhaustiveness: a new kind must decide on its own label rather than
      // silently inheriting a generic one.
      const _never: never = source;
      label = 'an unknown source';
      void _never;
    }
  }
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

/**
 * A file path shortened for a CHIP, not for the agent.
 *
 * The two audiences want different things and this is the one place they
 * diverge. The agent is given the full path, because a path it can hand to
 * `Read` is strictly more useful than a pretty one. The user is looking at a
 * small chip above a composer that can be 320px wide in the tool side panel,
 * where an absolute path is both unreadable and a layout hazard — and they
 * just opened the file, so the last two segments identify it fine.
 */
export function shortFileLabel(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join('/')}`;
}

/**
 * Build the text the agent receives.
 *
 * A markdown blockquote followed by a blank line and whatever the user typed.
 * The attribution line is deliberately conditional: quoting the assistant's own
 * prose needs no explanation, since the excerpt is verbatim in the transcript
 * directly above. Everything else does — an orphaned spreadsheet row tells the
 * agent nothing about which file it is looking at. Truncation always earns a
 * line regardless of source, because "I selected all of this" and "I selected
 * the first 8,000 characters of this" are different claims.
 *
 * Pure, and the only place composition happens: main calls it on the way to the
 * agent while persisting the typed text untouched, so what is stored and what
 * is sent cannot drift into two different implementations.
 */
export function composeQuotedText(quote: AcaboxQuote | undefined | null, typed: string): string {
  if (!quote || !quote.text) return typed;

  const blockquote = quote.text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');

  const needsAttribution = quote.source.kind !== 'message' || quote.truncated;
  const attribution = needsAttribution
    ? `\n(from ${describeQuoteSource(quote.source)}${quote.truncated ? ', excerpt truncated' : ''})`
    : '';

  const typedPart = typed.trim();
  return typedPart
    ? `${blockquote}${attribution}\n\n${typedPart}`
    : `${blockquote}${attribution}`;
}

/**
 * Defensive parse for a quote read back out of SQLite or off the IPC boundary.
 *
 * Both are places where the value was written by an older version of this app
 * (a row predating the feature, or a renderer mid-upgrade), so a malformed or
 * absent quote must degrade to "this message has no quote" rather than throw
 * inside a history render.
 */
export function parseStoredQuote(value: unknown): AcaboxQuote | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const q = value as Partial<AcaboxQuote>;
  if (typeof q.text !== 'string' || !q.text) return undefined;
  const source = q.source as QuoteSource | undefined;
  if (!source || typeof source !== 'object' || typeof (source as any).kind !== 'string') return undefined;
  if (!['message', 'tool', 'file', 'miniapp'].includes((source as any).kind)) return undefined;
  return {
    text: q.text,
    truncated: q.truncated === true,
    messageId: typeof q.messageId === 'string' ? q.messageId : '',
    source,
  };
}
