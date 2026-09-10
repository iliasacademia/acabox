import React from 'react';
import { useAuiState, useComposerRuntime, useMessageQuote } from '@assistant-ui/react';
import { MSymbol } from '../command-desk/MSymbol';
import { describeQuoteSource, shortFileLabel, type AcaboxQuote } from '../../../shared/quotes';
import type { FC } from 'react';

/**
 * The two places a quote is visible: as a removable chip above the composer
 * while drafting, and as a block attached to the sent message afterwards.
 *
 * Both read the SAME object. The library stores whatever `setQuote` was given
 * on the outgoing message's `metadata.custom.quote`, and the history converter
 * puts the persisted copy back in the same place, so an optimistic bubble and
 * one rehydrated from SQLite after a restart render through one path. That is
 * the property worth protecting if this is ever refactored: two renderers for
 * "before send" and "after reload" is how they drift.
 */

/** Line count shown before the excerpt is visually clamped. The full text is
 *  always what gets sent — this is a display concern only. */
const CHIP_CLAMP_LINES = 3;

function sourceIcon(quote: AcaboxQuote): string {
  switch (quote.source.kind) {
    case 'file': return 'draft';
    case 'tool': return 'terminal';
    case 'miniapp': return 'widgets';
    default: return 'format_quote';
  }
}

/**
 * Attribution shown to the user. Deliberately shown for EVERY source, unlike
 * the attribution sent to the agent (which is omitted for chat prose, where the
 * excerpt sits verbatim in the transcript directly above). The user is looking
 * at a chip detached from its origin and does need reminding which one it was.
 */
function chipLabel(quote: AcaboxQuote): string {
  // A file is the one source whose display label differs from what the agent
  // is told: it gets the full path (which it can act on), the chip gets the
  // tail (which fits and which the user can read).
  const base = quote.source.kind === 'file'
    ? shortFileLabel(quote.source.path)
    : describeQuoteSource(quote.source);
  return quote.truncated ? `${base} · truncated` : base;
}

/**
 * A file label is DATA — a case-sensitive path — while every other label is a
 * category ("your earlier reply"). The design system uppercases meta lines,
 * which is right for a category and wrong for a path: it silently rewrites
 * `MyResearch/Data.csv` as `MYRESEARCH/DATA.CSV`. Caught by looking at a
 * screenshot; no value assertion would have flagged it, since the component
 * was already holding the correct string.
 */
function isLiteralLabel(quote: AcaboxQuote): boolean {
  return quote.source.kind === 'file';
}

/** The chip above the composer input, in the slot attachments already occupy. */
export const ComposerQuoteChip: FC = () => {
  const composerRuntime = useComposerRuntime();
  const quote = useAuiState((s: any) => s.composer?.quote) as AcaboxQuote | undefined;
  if (!quote?.text) return null;

  return (
    <div className="cdQuoteChip">
      <span className="cdQuoteChip__rule" aria-hidden="true" />
      <div className="cdQuoteChip__body">
        <span className={`cdQuoteChip__meta${isLiteralLabel(quote) ? ' cdQuoteMeta--literal' : ''}`}>
          <MSymbol name={sourceIcon(quote)} size={13} />
          {chipLabel(quote)}
        </span>
        <span
          className="cdQuoteChip__text"
          style={{ WebkitLineClamp: CHIP_CLAMP_LINES }}
        >
          {quote.text}
        </span>
      </div>
      <button
        type="button"
        className="cdQuoteChip__remove"
        aria-label="Remove quote"
        title="Remove quote"
        onClick={() => composerRuntime.setQuote(undefined)}
      >
        <MSymbol name="close" size={14} />
      </button>
    </div>
  );
};

/**
 * The quote block attached to a sent user message.
 *
 * Registered as `components.Quote` on `MessagePrimitive.Parts`, which renders
 * it above the parts whenever `metadata.custom.quote` is present. The props the
 * library passes are its own narrow `QuoteInfo`; the full object with its
 * provenance is read back through `useMessageQuote`, which returns the stored
 * value untouched.
 */
export const MessageQuoteBlock: FC<{ text: string; messageId: string }> = () => {
  const quote = useMessageQuote() as AcaboxQuote | undefined;
  if (!quote?.text) return null;
  return (
    <div className="cdMsgQuote">
      <span className={`cdMsgQuote__meta${isLiteralLabel(quote) ? ' cdQuoteMeta--literal' : ''}`}>
        <MSymbol name={sourceIcon(quote)} size={12} />
        {chipLabel(quote)}
      </span>
      <blockquote className="cdMsgQuote__text">{quote.text}</blockquote>
    </div>
  );
};
