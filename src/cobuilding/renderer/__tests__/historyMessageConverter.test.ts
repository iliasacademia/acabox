/**
 * Pins the shared history converter so the desktop chat panel and the
 * Word overlay produce IDENTICAL ThreadMessageLike output for the same
 * stored DB rows. The two surfaces transport the rows differently
 * (Electron IPC returns string content; the HTTP route JSON.parses it
 * server-side), but once normalized into HistoryDbMessage the converter
 * treats both inputs as equivalent.
 *
 * The cases below cover the historical drift points:
 *   - User-message attachments (overlay used to drop these; desktop kept them).
 *   - Tool-use blocks merged with their tool_result counterparts via tool_use_id.
 *   - Multiple consecutive assistant rows folded into one conversation message.
 *   - Empty / malformed content shapes.
 */

import {
  convertHistoryMessages,
  convertHistoryMessagesFromStringContent,
  type HistoryDbMessage,
} from '../historyMessageConverter';

describe('convertHistoryMessages', () => {
  it('preserves a plain text exchange', () => {
    const rows: HistoryDbMessage[] = [
      { type: 'user', content: { text: 'hi' } },
      { type: 'assistant', content: [{ type: 'text', text: 'hello!' }] },
    ];
    expect(convertHistoryMessages(rows)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello!' }] },
    ]);
  });

  it('preserves user-message attachments (the divergence we just collapsed)', () => {
    const rows: HistoryDbMessage[] = [
      {
        type: 'user',
        content: {
          text: 'see attached',
          attachments: [
            { type: 'image', mediaType: 'image/png', name: 'fig1.png' },
            { type: 'document', mediaType: 'application/pdf', title: 'paper.pdf' },
          ],
        },
      },
    ];
    const result = convertHistoryMessages(rows);
    expect(result).toEqual([
      {
        role: 'user',
        content: 'see attached',
        attachments: [
          { id: 'att-0', type: 'image', name: 'fig1.png', contentType: 'image/png', status: { type: 'complete' }, content: [] },
          { id: 'att-1', type: 'document', name: 'paper.pdf', contentType: 'application/pdf', status: { type: 'complete' }, content: [] },
        ],
      },
    ]);
  });

  it('merges tool_use blocks with their tool_result counterparts via tool_use_id', () => {
    const rows: HistoryDbMessage[] = [
      { type: 'user', content: { text: 'find papers' } },
      {
        type: 'assistant',
        content: [
          { type: 'text', text: 'Searching now…' },
          { type: 'tool_use', id: 'call-1', name: 'mcp__citeright__find_references', input: { q: 'circadian' } },
        ],
      },
      {
        type: 'tool_result',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'found 5 papers' },
        ],
      },
      { type: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];
    const result = convertHistoryMessages(rows);
    // tool_result rows do not produce their own message — they fold into the tool-call block.
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'user', content: 'find papers' });
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toEqual([
      { type: 'text', text: 'Searching now…' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'mcp__citeright__find_references',
        args: { q: 'circadian' },
        result: 'found 5 papers',
        isError: false,
      },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('marks tool-call as error when the tool_result.is_error is true', () => {
    const rows: HistoryDbMessage[] = [
      {
        type: 'assistant',
        content: [{ type: 'tool_use', id: 'call-x', name: 'broken_tool', input: {} }],
      },
      {
        type: 'tool_result',
        content: [{ type: 'tool_result', tool_use_id: 'call-x', content: 'oops', is_error: true }],
      },
    ];
    const result = convertHistoryMessages(rows);
    const block = (result[0].content as any[])[0];
    expect(block.isError).toBe(true);
    expect(block.result).toBe('oops');
  });

  it('folds consecutive assistant rows into a single thread message', () => {
    // Some agents emit multiple assistant rows for one logical turn (e.g.
    // text → tool_use → text). The converter merges them so the thread
    // shows one assistant bubble, not three.
    const rows: HistoryDbMessage[] = [
      { type: 'assistant', content: [{ type: 'text', text: 'one' }] },
      { type: 'assistant', content: [{ type: 'text', text: ' two' }] },
      { type: 'user', content: { text: 'reply' } },
    ];
    const result = convertHistoryMessages(rows);
    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'text', text: ' two' }] },
      { role: 'user', content: 'reply' },
    ]);
  });

  it('drops unrecognized assistant block types but keeps text/tool_use', () => {
    const rows: HistoryDbMessage[] = [
      {
        type: 'assistant',
        content: [
          { type: 'text', text: 'kept' },
          { type: 'thinking', text: 'dropped — not surfaced as a history block' } as any,
          { type: 'tool_use', id: 'k', name: 'n', input: {} },
        ],
      },
    ];
    expect(convertHistoryMessages(rows)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'kept' },
          { type: 'tool-call', toolCallId: 'k', toolName: 'n', args: {}, result: undefined, isError: false },
        ],
      },
    ]);
  });

  it('handles malformed content shapes without throwing', () => {
    const rows: HistoryDbMessage[] = [
      { type: 'user', content: null },
      { type: 'assistant', content: 'not-an-array' },
      { type: 'tool_result', content: { not: 'an array either' } },
      { type: 'unknown', content: { whatever: true } },
    ];
    expect(() => convertHistoryMessages(rows)).not.toThrow();
    // Empty user text + empty assistant content => only the empty user row
    // survives (assistant has zero blocks so the flush drops it).
    const result = convertHistoryMessages(rows);
    expect(result).toEqual([{ role: 'user', content: '' }]);
  });
});

describe('convertHistoryMessagesFromStringContent', () => {
  it('produces identical output to convertHistoryMessages for parsed-vs-stringified inputs', () => {
    // Same data, two transports: this is the desktop-vs-overlay parity
    // contract. If the same DB row would render differently between the
    // two surfaces, this test fails.
    const objectInput: HistoryDbMessage[] = [
      { type: 'user', content: { text: 'hi', attachments: [{ type: 'image', mediaType: 'image/png', name: 'a.png' }] } },
      { type: 'assistant', content: [{ type: 'text', text: 'hey' }, { type: 'tool_use', id: 't1', name: 'do_thing', input: { x: 1 } }] },
      { type: 'tool_result', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];
    const stringInput = objectInput.map((m) => ({ type: m.type, content: JSON.stringify(m.content) }));

    const fromObjects = convertHistoryMessages(objectInput);
    const fromStrings = convertHistoryMessagesFromStringContent(stringInput);

    expect(fromStrings).toEqual(fromObjects);
  });

  it('falls back to empty for unparseable string content rather than throwing', () => {
    const rows = [
      { type: 'user', content: 'not json' },
    ];
    expect(() => convertHistoryMessagesFromStringContent(rows)).not.toThrow();
    expect(convertHistoryMessagesFromStringContent(rows)).toEqual([
      { role: 'user', content: '' },
    ]);
  });
});

/**
 * A quoted excerpt has to survive a restart, and it has to come back in the
 * exact place the live composer writes it — `metadata.custom.quote` — because
 * that is what lets one component render both an optimistic bubble and a
 * rehydrated one. Two renderers for "before send" and "after reload" is how
 * they drift.
 *
 * The rows below are the literal shape `agentSession.sendMessage` writes.
 */
describe('quoted user messages', () => {
  const quote = {
    text: 'n_refs counts mentions',
    truncated: false,
    messageId: 'm-42',
    source: { kind: 'message', role: 'assistant' },
  };

  it('restores a quote onto metadata.custom.quote', () => {
    const rows = [
      { type: 'user', content: JSON.stringify({ text: 'Is that per user?', quote }) },
    ];
    const [message] = convertHistoryMessagesFromStringContent(rows);
    expect(message).toEqual({
      role: 'user',
      content: 'Is that per user?',
      metadata: { custom: { quote } },
    });
  });

  it('keeps the TYPED text, not the composed blockquote', () => {
    // The row stores what the user typed; the blockquote is built on the way
    // to the agent and lives only in the transcript. Storing the composed
    // string instead would make the bubble show the excerpt twice — once as
    // its own block and once inside the message text.
    const rows = [
      { type: 'user', content: JSON.stringify({ text: 'Is that per user?', quote }) },
    ];
    const [message] = convertHistoryMessagesFromStringContent(rows);
    expect(message.content).toBe('Is that per user?');
    expect(String(message.content)).not.toContain('>');
  });

  it('carries a quote alongside attachments and a timestamp', () => {
    const rows = [{
      type: 'user',
      content: JSON.stringify({
        text: 'look',
        quote,
        attachments: [{ type: 'document', mediaType: 'application/pdf', name: 'paper.pdf' }],
      }),
      created_at: '2026-09-09T10:00:00.000Z',
    }];
    const [message] = convertHistoryMessagesFromStringContent(rows) as any[];
    expect(message.metadata.custom.quote).toEqual(quote);
    expect(message.attachments).toHaveLength(1);
    expect(message.createdAt).toEqual(new Date('2026-09-09T10:00:00.000Z'));
  });

  it('emits no metadata at all for a row written before quoting existed', () => {
    // Every row already in every user's database looks like this. An empty
    // `metadata.custom` would be harmless but is still a lie about the row.
    const rows = [{ type: 'user', content: JSON.stringify({ text: 'plain' }) }];
    expect(convertHistoryMessagesFromStringContent(rows)).toEqual([
      { role: 'user', content: 'plain' },
    ]);
  });

  it('drops a malformed quote rather than failing the whole history render', () => {
    // A row a newer or older build wrote. Losing one chip is recoverable;
    // throwing inside the converter blanks the entire conversation.
    const rows = [
      { type: 'user', content: JSON.stringify({ text: 'a', quote: { text: 'x' } }) },
      { type: 'user', content: JSON.stringify({ text: 'b', quote: 'not an object' }) },
      { type: 'user', content: JSON.stringify({ text: 'c', quote: { source: { kind: 'file', path: 'p' } } }) },
    ];
    const messages = convertHistoryMessagesFromStringContent(rows);
    expect(messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
  });

  it('restores a file quote, whose anchor is synthetic', () => {
    const fileQuote = {
      text: '39,335',
      truncated: true,
      messageId: 'src:file:counts.csv',
      source: { kind: 'file', path: 'counts.csv' },
    };
    const rows = [{ type: 'user', content: JSON.stringify({ text: 'why?', quote: fileQuote }) }];
    const [message] = convertHistoryMessagesFromStringContent(rows) as any[];
    expect(message.metadata.custom.quote).toEqual(fileQuote);
  });
});
