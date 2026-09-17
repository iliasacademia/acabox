import {
  formatChatRef,
  parseChatRefs,
  composeChatRefText,
  parseStoredChatRefs,
  chatIdMatchesRef,
  splitOnChatRefs,
  CHAT_REF_ID_CHARS,
  MAX_CHAT_REFS_PER_MESSAGE,
  type AcaboxChatRef,
} from '../chatRefs';

const ID = '177d891b-0088-4162-8a56-81d213c0015c';
const ref = (sessionId: string, title = 'Hex HTTP 403'): AcaboxChatRef => ({ sessionId, title });

describe('formatChatRef / parseChatRefs', () => {
  it('writes a short reference and reads it back', () => {
    // Short because a 45-character token in a composer someone is typing a
    // sentence into is unusable. Resolution is a prefix match in main.
    expect(formatChatRef(ID)).toBe('[[chat:177d891b]]');
    expect(parseChatRefs(`see ${formatChatRef(ID)} for context`)).toEqual(['177d891b']);
    expect(chatIdMatchesRef(ID, '177d891b')).toBe(true);
    expect(chatIdMatchesRef(ID, '177D891B')).toBe(true);
    expect(chatIdMatchesRef('1999a146-92e2-4ac7-a8c1-99117e15ebde', '177d891b')).toBe(false);
  });

  it('still accepts a full id, so an old or hand-written reference resolves', () => {
    expect(parseChatRefs(`[[chat:${ID}]]`)).toEqual([ID]);
    expect(chatIdMatchesRef(ID, ID)).toBe(true);
    expect(CHAT_REF_ID_CHARS).toBe(8);
  });

  it('finds several references and drops duplicates in place', () => {
    const other = '1999a146-92e2-4ac7-a8c1-99117e15ebde';
    const text = `${formatChatRef(ID)} and ${formatChatRef(other)} and ${formatChatRef(ID)} again`;
    expect(parseChatRefs(text)).toEqual(['177d891b', '1999a146']);
  });

  it('ignores tokens that are not ours', () => {
    // A wiki link, a near-miss prefix, and an id with characters randomUUID
    // cannot produce. Treating any of these as a chat id would send the agent
    // hunting for a chat that was never referenced.
    expect(parseChatRefs('[[Some Page]] [[chats:abc]] [[chat:has spaces]] [[chat:a/../b]]')).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    expect(parseChatRefs('')).toEqual([]);
  });
});

describe('composeChatRefText', () => {
  it('is a no-op when there are no references', () => {
    expect(composeChatRefText(undefined, 'hello')).toBe('hello');
    expect(composeChatRefText([], 'hello')).toBe('hello');
  });

  it('says plainly when a reference no longer resolves, instead of dropping it', () => {
    // Dropping it leaves the model reading a message that gestures at context
    // it never received — and answering from the surrounding sentence.
    const out = composeChatRefText(
      [{ sessionId: 'deadbeef', title: '', unresolved: 'not_found' }],
      'what did we decide?',
    );
    expect(out).toContain('deadbeef');
    expect(out).toContain('no chat with that id exists');
    expect(out).toContain('Do not guess');
    expect(out).toContain('what did we decide?');
  });

  it('reports an ambiguous prefix with its candidates rather than picking one', () => {
    const out = composeChatRefText(
      [{ sessionId: 'aa', title: '', unresolved: 'ambiguous', candidates: ['aa11', 'aa22'] }],
      'go',
    );
    expect(out).toContain('matches more than one chat');
    expect(out).toContain('aa11');
    expect(out).toContain('aa22');
    expect(out).not.toContain('read_chat tool with that id');
  });

  it('announces the chat without carrying its contents', () => {
    const out = composeChatRefText([ref(ID)], 'what did we conclude?');
    expect(out).toContain(ID);
    expect(out).toContain('Hex HTTP 403');
    expect(out).toContain('what did we conclude?');
    // The two load-bearing claims. Drop either and the most likely failure is
    // a model answering from the title alone, or one that cannot find the door.
    expect(out).toContain('NOT included');
    expect(out).toContain('read_chat');
  });

  it('puts the typed text after the announcement', () => {
    const out = composeChatRefText([ref(ID)], 'my question');
    expect(out.indexOf('Referenced chat')).toBeLessThan(out.indexOf('my question'));
  });

  it('works with no typed text at all', () => {
    const out = composeChatRefText([ref(ID)], '   ');
    expect(out).toContain(ID);
    expect(out.endsWith(']')).toBe(true);
  });

  it('caps how many references one message can carry', () => {
    const many = Array.from({ length: 9 }, (_, i) => ref(`id-${i}`));
    const out = composeChatRefText(many, 'go');
    const announced = out.split('\n').filter((l) => l.startsWith('[Referenced chat'));
    expect(announced).toHaveLength(MAX_CHAT_REFS_PER_MESSAGE);
  });

  it('flattens and truncates a pathological title so it cannot become the payload', () => {
    const out = composeChatRefText([ref(ID, `${'x'.repeat(500)}\nsecond line`)], 'go');
    const line = out.split('\n')[0];
    expect(line.length).toBeLessThan(400);
    expect(out.split('\n').filter((l) => l.startsWith('[Referenced chat'))).toHaveLength(1);
  });
});

describe('parseStoredChatRefs', () => {
  it('reads back what the composer stored', () => {
    expect(parseStoredChatRefs([{ sessionId: ID, title: 'Hex' }]))
      .toEqual([{ sessionId: ID, title: 'Hex' }]);
  });

  it('degrades to undefined rather than throwing on anything malformed', () => {
    // Each of these is a shape a row written by an older build could hold.
    expect(parseStoredChatRefs(undefined)).toBeUndefined();
    expect(parseStoredChatRefs(null)).toBeUndefined();
    expect(parseStoredChatRefs('[[chat:x]]')).toBeUndefined();
    expect(parseStoredChatRefs([])).toBeUndefined();
    expect(parseStoredChatRefs([{ title: 'no id' }])).toBeUndefined();
    expect(parseStoredChatRefs([{ sessionId: '' }])).toBeUndefined();
  });

  it('keeps the good entries and skips the broken ones', () => {
    const out = parseStoredChatRefs([{ sessionId: ID }, null, { nope: 1 }, { sessionId: 'b', title: 'B' }]);
    expect(out).toEqual([{ sessionId: ID, title: 'Untitled chat' }, { sessionId: 'b', title: 'B' }]);
  });
});

describe('splitOnChatRefs', () => {
  it('leaves text with no reference as a single run', () => {
    expect(splitOnChatRefs('just prose')).toEqual([{ kind: 'text', text: 'just prose' }]);
  });

  it('separates references from the prose around them', () => {
    expect(splitOnChatRefs('see [[chat:177d891b]] and [[chat:1999a146]] too')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'ref', written: '177d891b' },
      { kind: 'text', text: ' and ' },
      { kind: 'ref', written: '1999a146' },
      { kind: 'text', text: ' too' },
    ]);
  });

  it('handles a reference at each edge with no surrounding text', () => {
    expect(splitOnChatRefs('[[chat:abc12345]]')).toEqual([{ kind: 'ref', written: 'abc12345' }]);
  });

  it('keeps duplicates, unlike parseChatRefs', () => {
    // The renderer draws every occurrence; the sender announces each chat
    // once. Both are right, and collapsing here would drop a chip the user
    // can see in their own text.
    const out = splitOnChatRefs('[[chat:aaaaaaaa]] x [[chat:aaaaaaaa]]');
    expect(out.filter((s) => s.kind === 'ref')).toHaveLength(2);
    expect(parseChatRefs('[[chat:aaaaaaaa]] x [[chat:aaaaaaaa]]')).toHaveLength(1);
  });
});
