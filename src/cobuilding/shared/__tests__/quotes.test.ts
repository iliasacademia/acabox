/**
 * The wire format and the cap.
 *
 * `composeQuotedText` is the only place a quote becomes text the model sees,
 * so these cases are the specification of what the agent receives — including
 * the two rules that are easy to get backwards: attribution is omitted for
 * chat prose but never for truncation, and the excerpt the row stores is not
 * the string that gets sent.
 */

import {
  MAX_QUOTE_CHARS,
  composeQuotedText,
  describeQuoteSource,
  parseStoredQuote,
  prepareQuoteText,
  shortFileLabel,
  type AcaboxQuote,
} from '../quotes';

const quote = (over: Partial<AcaboxQuote> = {}): AcaboxQuote => ({
  text: 'the excerpt',
  truncated: false,
  messageId: 'msg-1',
  source: { kind: 'message', role: 'assistant' },
  ...over,
});

describe('prepareQuoteText', () => {
  it('returns null for a selection that is only whitespace', () => {
    expect(prepareQuoteText('   \n\t  ')).toBeNull();
    expect(prepareQuoteText('')).toBeNull();
  });

  it('trims the whitespace a drag-selection picks up', () => {
    expect(prepareQuoteText('  hello world \n')).toEqual({ text: 'hello world', truncated: false });
  });

  it('leaves anything at or under the cap untouched and unflagged', () => {
    const exact = 'x'.repeat(MAX_QUOTE_CHARS);
    expect(prepareQuoteText(exact)).toEqual({ text: exact, truncated: false });
  });

  it('caps an oversized selection and flags it', () => {
    // The failure this guards is real and has happened here: a 39,335-row CSV
    // inlined into a turn produced a transcript that every later turn replayed
    // and the API rejected, permanently. A selection is one Cmd-A away from
    // the same shape.
    const huge = 'y'.repeat(MAX_QUOTE_CHARS * 3);
    const prepared = prepareQuoteText(huge)!;
    expect(prepared.truncated).toBe(true);
    expect(prepared.text.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS + 1); // +1 for the ellipsis
    expect(prepared.text.endsWith('…')).toBe(true);
  });

  it('prefers a word boundary but does not sacrifice more than 10% to find one', () => {
    // A long run of words: the cut should land on a space.
    const wordy = `${'word '.repeat(MAX_QUOTE_CHARS)}`;
    const prepared = prepareQuoteText(wordy)!;
    expect(prepared.text.endsWith('word…')).toBe(true);

    // One unbroken token with a space only at the very start: falling back to
    // the hard cut keeps ~all of the budget rather than throwing it away.
    const oneToken = `a ${'b'.repeat(MAX_QUOTE_CHARS * 2)}`;
    const hard = prepareQuoteText(oneToken)!;
    expect(hard.text.length).toBeGreaterThan(MAX_QUOTE_CHARS * 0.9);
  });
});

describe('composeQuotedText', () => {
  it('is a no-op when there is no quote', () => {
    expect(composeQuotedText(undefined, 'just a message')).toBe('just a message');
    expect(composeQuotedText(null, 'just a message')).toBe('just a message');
  });

  it('prefixes chat prose as a bare blockquote, with no attribution', () => {
    // The excerpt sits verbatim in the transcript directly above, so naming
    // the source would be noise on the common case.
    expect(composeQuotedText(quote({ text: 'n_refs counts mentions' }), 'Is that per user?'))
      .toBe('> n_refs counts mentions\n\nIs that per user?');
  });

  it('quotes every line, including the blank ones', () => {
    const composed = composeQuotedText(quote({ text: 'one\n\ntwo' }), 'why?');
    expect(composed).toBe('> one\n>\n> two\n\nwhy?');
  });

  it('names the source for a file, which has no surrounding context', () => {
    const composed = composeQuotedText(
      quote({ text: '39,335 rows', source: { kind: 'file', path: 'MyResearch/counts.csv' } }),
      'Why is this off?',
    );
    expect(composed).toBe('> 39,335 rows\n(from MyResearch/counts.csv)\n\nWhy is this off?');
  });

  it('names the source for tool output and for a mini-app', () => {
    expect(composeQuotedText(quote({ source: { kind: 'tool', toolName: 'Bash' } }), 'x'))
      .toContain('(from the Bash tool output)');
    expect(composeQuotedText(
      quote({ source: { kind: 'miniapp', appDirName: 'dna', appName: 'DNA Toolkit' } }), 'x',
    )).toContain('(from the DNA Toolkit tool)');
  });

  it('always states truncation, even for chat prose that is otherwise unattributed', () => {
    // "I selected all of this" and "I selected the first 8,000 characters of
    // this" are different claims and the model must not be told the first.
    const composed = composeQuotedText(quote({ truncated: true }), 'summarize');
    expect(composed).toContain('(from your earlier reply, excerpt truncated)');
  });

  it('sends the quote alone when the user typed nothing', () => {
    // The composer treats a quote as making it non-empty, so this is reachable.
    expect(composeQuotedText(quote({ text: 'look at this' }), '')).toBe('> look at this');
    expect(composeQuotedText(quote({ text: 'look at this' }), '   ')).toBe('> look at this');
  });

  it('distinguishes a thinking block from ordinary reply prose', () => {
    const composed = composeQuotedText(
      quote({ truncated: true, source: { kind: 'message', role: 'reasoning' } }), 'x',
    );
    expect(composed).toContain('from your thinking');
  });
});

describe('describeQuoteSource', () => {
  it('caps a pathological label so it cannot become the payload itself', () => {
    const label = describeQuoteSource({ kind: 'file', path: 'a'.repeat(5000) });
    expect(label.length).toBeLessThanOrEqual(200);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('shortFileLabel', () => {
  it('keeps the tail, which is what identifies a file the user just opened', () => {
    expect(shortFileLabel('/Users/x/Library/Application Support/acabox/workspace/tool-data/liver/output/composition.json'))
      .toBe('…/output/composition.json');
  });

  it('leaves a short path alone rather than adding a misleading ellipsis', () => {
    expect(shortFileLabel('counts.csv')).toBe('counts.csv');
    expect(shortFileLabel('data/counts.csv')).toBe('data/counts.csv');
  });

  it('does not change what the AGENT is told, which stays the full path', () => {
    // The divergence is deliberate and one-directional: a path the agent can
    // hand to Read is more useful than a pretty one, while the chip has 320px
    // in the side-panel composer.
    const full = '/Users/x/deep/nested/counts.csv';
    expect(describeQuoteSource({ kind: 'file', path: full })).toBe(full);
    expect(shortFileLabel(full)).toBe('…/nested/counts.csv');
  });
});

describe('parseStoredQuote', () => {
  it('accepts a well-formed quote', () => {
    expect(parseStoredQuote(quote())).toEqual(quote());
  });

  it('degrades to undefined rather than throwing on anything malformed', () => {
    // Reached from two places that can hold values this build did not write:
    // a SQLite row from an older version, and the IPC boundary.
    for (const bad of [
      undefined, null, 'a string', 42, {},
      { text: '' },
      { text: 'x' },                                     // no source
      { text: 'x', source: {} },                         // source with no kind
      { text: 'x', source: { kind: 'wormhole' } },       // unknown kind
      { source: { kind: 'message', role: 'assistant' } },// no text
    ]) {
      expect(parseStoredQuote(bad)).toBeUndefined();
    }
  });

  it('normalizes a missing truncated flag and a missing anchor', () => {
    const parsed = parseStoredQuote({ text: 'x', source: { kind: 'message', role: 'user' } })!;
    expect(parsed.truncated).toBe(false);
    expect(parsed.messageId).toBe('');
  });
});
