import {
  renderChatTranscript,
  excerptAround,
  rowPlainText,
  DEFAULT_READ_CHARS,
  MAX_READ_CHARS,
  type TranscriptRow,
} from '../chatTranscript';

/* Row shapes below are lifted from the real production database, not
 * invented: a `user` row is a JSON envelope, an `assistant` row is the SDK's
 * content-block array, and a `tool_result` row is the array of result blocks
 * the SDK sends back as a user message. */

const userRow = (text: string, extra: Record<string, unknown> = {}): TranscriptRow =>
  ({ type: 'user', content: JSON.stringify({ text, ...extra }) });

const assistantRow = (blocks: unknown[]): TranscriptRow =>
  ({ type: 'assistant', content: JSON.stringify(blocks) });

const textBlock = (text: string) => ({ type: 'text', text });
const toolUse = (name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id: 'toolu_01', name, input, caller: { type: 'direct' } });

describe('renderChatTranscript', () => {
  it('renders a two-sided exchange with speaker headings', () => {
    const out = renderChatTranscript([
      userRow('Why do I get a 403?'),
      assistantRow([textBlock('Let me look.')]),
    ]);
    expect(out.text).toBe('## You\nWhy do I get a 403?\n\n## Claude\nLet me look.');
    expect(out.totalBlocks).toBe(2);
    expect(out.elidedBlocks).toBe(0);
  });

  it('merges the several rows of one reply into a single Claude turn', () => {
    // The database writes one row per streamed message, so a reply that calls
    // two tools is three rows. Rendered as three turns it reads as a stutter.
    const out = renderChatTranscript([
      userRow('go'),
      assistantRow([textBlock('First.')]),
      assistantRow([toolUse('Read', { file_path: '/tmp/a.md' })]),
      assistantRow([textBlock('Done.')]),
    ]);
    expect(out.totalBlocks).toBe(2);
    expect((out.text.match(/## Claude/g) ?? [])).toHaveLength(1);
  });

  it('collapses a tool call to one line naming its most informative argument', () => {
    const out = renderChatTranscript([
      assistantRow([toolUse('Read', { file_path: '/tmp/notes.md' })]),
      assistantRow([toolUse('Grep', { pattern: 'pk_content', output_mode: 'content', '-n': true })]),
      assistantRow([toolUse('Bash', { command: 'curl -s https://example.com', description: 'fetch' })]),
    ]);
    expect(out.text).toContain('[Read: /tmp/notes.md]');
    expect(out.text).toContain('[Grep: pk_content]');
    // `command` outranks `description` — the command is what was actually run.
    expect(out.text).toContain('[Bash: curl -s https://example.com]');
  });

  it('names a tool even when nothing in its input is printable', () => {
    const out = renderChatTranscript([assistantRow([toolUse('read_graph', {})])]);
    expect(out.text).toContain('[read_graph]');
  });

  it('drops thinking blocks entirely, signature and all', () => {
    // Real thinking rows carry an empty `thinking` and a multi-kilobyte
    // base64 `signature`. Emitting it would be pure noise, and a large amount
    // of it.
    const signature = 'CAISqgQKhwEIEBgCKkDMz9YEZA1e'.repeat(80);
    const out = renderChatTranscript([
      assistantRow([{ type: 'thinking', thinking: '', signature }]),
      assistantRow([textBlock('Here is the answer.')]),
    ]);
    expect(out.text).not.toContain('CAISqgQ');
    expect(out.text).toBe('## Claude\nHere is the answer.');
  });

  it('omits tool output by default and includes an excerpt when asked', () => {
    const rows: TranscriptRow[] = [
      assistantRow([toolUse('Read', { file_path: '/tmp/a.md' })]),
      {
        type: 'tool_result',
        content: JSON.stringify([
          { tool_use_id: 'toolu_01', type: 'tool_result', content: 'SECRETLY_LONG_FILE_BODY' },
        ]),
      },
    ];
    expect(renderChatTranscript(rows).text).not.toContain('SECRETLY_LONG_FILE_BODY');
    expect(renderChatTranscript(rows, { includeToolOutput: true }).text)
      .toContain('SECRETLY_LONG_FILE_BODY');
  });

  it('carries a quoted excerpt, because the typed text often does not stand alone', () => {
    const out = renderChatTranscript([
      userRow('is this right?', { quote: { text: 'line one\nline two', truncated: false } }),
    ]);
    expect(out.text).toContain('> line one');
    expect(out.text).toContain('> line two');
    expect(out.text).toContain('is this right?');
  });

  it('names attachments', () => {
    const out = renderChatTranscript([
      userRow('have a look', { attachments: [{ type: 'file_reference', name: 'data.csv' }] }),
    ]);
    expect(out.text).toContain('(attached: data.csv)');
  });

  it('marks a turn that ended in an error', () => {
    const out = renderChatTranscript([
      assistantRow([textBlock('trying')]),
      { type: 'result', content: JSON.stringify({ subtype: 'error', is_error: true }) },
    ]);
    expect(out.text).toContain('this turn ended with an error');
  });

  it('says so rather than returning an empty string for a chat with nothing in it', () => {
    expect(renderChatTranscript([]).text).toContain('no messages yet');
  });

  it('does not throw on a row whose content is not JSON', () => {
    const out = renderChatTranscript([{ type: 'user', content: 'plain text, no envelope' }]);
    expect(out.text).toContain('plain text, no envelope');
  });

  describe('budget', () => {
    // 40 exchanges, one of which rambles. Total is far over any budget used
    // here, so the policy is what is under test, not the arithmetic.
    const manyTurns = (): TranscriptRow[] => {
      const rows: TranscriptRow[] = [];
      for (let i = 0; i < 40; i++) {
        rows.push(userRow(`question ${i}`));
        rows.push(assistantRow([textBlock(i === 5 ? 'R'.repeat(40_000) : `answer ${i}`)]));
      }
      return rows;
    };

    it('trims the long turn instead of discarding whole exchanges', () => {
      // The regression this pins: cutting at turn granularity discarded 26 of
      // 50 exchanges from a real chat to save 7 KB, because one reply can be
      // larger than every other reply put together. A reader handed half a
      // conversation cannot tell the other half existed.
      const out = renderChatTranscript(manyTurns(), { maxChars: 20_000 });
      expect(out.elidedBlocks).toBe(0);
      expect(out.text.length).toBeLessThanOrEqual(20_000);
      expect(out.text).toContain('question 0');
      expect(out.text).toContain('question 39');
      expect(out.text).toContain('characters trimmed');
      // Every short turn survives untouched.
      for (let i = 0; i < 40; i++) expect(out.text).toContain(`question ${i}`);
    });

    it('leaves a conversation that already fits completely alone', () => {
      const rows = [userRow('short'), assistantRow([textBlock('also short')])];
      const out = renderChatTranscript(rows, { maxChars: 20_000 });
      expect(out.text).not.toContain('trimmed');
      expect(out.text).not.toContain('omitted');
    });

    it('keeps every turn even on a tight budget when the turns are short', () => {
      // 80 turns in 4,000 characters looks impossible by division and is not:
      // 79 of them are twenty characters long, so trimming the one rambling
      // reply is enough. Dropping turns here would be a self-inflicted loss.
      const out = renderChatTranscript(manyTurns(), { maxChars: 4_000 });
      expect(out.elidedBlocks).toBe(0);
      expect(out.text.length).toBeLessThanOrEqual(4_000);
    });

    it('drops turns only when even a floor-sized share will not go round, and says how many', () => {
      // 200 turns that are all substantial. No amount of trimming fits them,
      // so turns have to go — and the count must be reported, because a
      // reader who is not told cannot know to ask for more.
      const rows: TranscriptRow[] = [];
      for (let i = 0; i < 100; i++) {
        rows.push(userRow(`question ${i} ${'q'.repeat(1_200)}`));
        rows.push(assistantRow([textBlock(`answer ${i} ${'a'.repeat(1_200)}`)]));
      }
      const out = renderChatTranscript(rows, { maxChars: 20_000 });
      expect(out.elidedBlocks).toBeGreaterThan(0);
      expect(out.text).toContain('omitted');
      expect(out.text.length).toBeLessThanOrEqual(20_000);
      // Both ends are kept: the opening question and the latest exchange.
      expect(out.text).toContain('question 0');
      expect(out.text).toContain('answer 99');
    });

    it('refuses to exceed the hard ceiling however much a caller asks for', () => {
      const huge = [userRow('q'), assistantRow([textBlock('X'.repeat(500_000))])];
      const out = renderChatTranscript(huge, { maxChars: 10_000_000 });
      expect(out.text.length).toBeLessThanOrEqual(MAX_READ_CHARS);
    });

    it('defaults to a budget that fits a typical whole conversation', () => {
      expect(DEFAULT_READ_CHARS).toBe(60_000);
    });
  });
});

describe('excerptAround', () => {
  it('centres on the match and ellipsizes both sides', () => {
    const text = `${'a'.repeat(300)} NEEDLE ${'b'.repeat(300)}`;
    const out = excerptAround(text, 'needle', 20)!;
    expect(out).toContain('NEEDLE');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns null when the needle is absent', () => {
    expect(excerptAround('nothing here', 'missing')).toBeNull();
    expect(excerptAround('text', '')).toBeNull();
  });
});

describe('rowPlainText', () => {
  it('gives prose for user and assistant rows and nothing for tool rows', () => {
    expect(rowPlainText(userRow('hello'))).toBe('hello');
    expect(rowPlainText(assistantRow([textBlock('hi')]))).toBe('hi');
    expect(rowPlainText({ type: 'tool_result', content: '[]' })).toBe('');
  });
});
