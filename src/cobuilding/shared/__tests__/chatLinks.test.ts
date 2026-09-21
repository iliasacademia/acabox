/**
 * `shared/chatLinks.ts` — the one contract main, the renderer and the agent
 * tool descriptions all depend on. Pure, so these run with no mocks.
 */
import {
  buildChatLink,
  composeChatRefsText,
  describeChatRef,
  extractChatId,
  formatStoredAt,
  isChatLink,
  parseChatLinks,
  splitTextByChatLinks,
  type ChatRef,
} from '../chatLinks';

const A = '14027f7d-6112-42c0-9d63-b420467d490c';
const B = '2cf62d69-7262-4bbe-8470-97dfab88cae0';

describe('chat links — build / parse', () => {
  it('round-trips an id through a link', () => {
    expect(buildChatLink(A)).toBe(`acabox://chat/${A}`);
    expect(parseChatLinks(buildChatLink(A))).toEqual([A]);
  });

  it('finds every distinct link in prose, first occurrence first, lower-cased', () => {
    const text = `see acabox://chat/${B.toUpperCase()} and acabox://chat/${A}, again acabox://chat/${B}`;
    expect(parseChatLinks(text)).toEqual([B, A]);
  });

  it('ignores near-misses: wrong scheme, wrong path, malformed id', () => {
    expect(parseChatLinks('acabox://tool/foo acabox://chat/not-a-uuid https://x/chat/' + A)).toEqual([]);
  });

  it('returns [] for empty or non-string input', () => {
    expect(parseChatLinks('')).toEqual([]);
    expect(parseChatLinks(undefined as unknown as string)).toEqual([]);
  });

  it('is safe to call repeatedly (no shared regex lastIndex)', () => {
    const text = `acabox://chat/${A}`;
    expect(parseChatLinks(text)).toEqual([A]);
    expect(parseChatLinks(text)).toEqual([A]);
  });
});

describe('extractChatId / isChatLink', () => {
  it('accepts a link, an angle-bracketed link, a link with trailing punctuation, and a bare id', () => {
    expect(extractChatId(`acabox://chat/${A}`)).toBe(A);
    expect(extractChatId(`<acabox://chat/${A}>`)).toBe(A);
    expect(extractChatId(`acabox://chat/${A}.`)).toBe(A);
    expect(extractChatId(A.toUpperCase())).toBe(A);
  });

  it('rejects anything else', () => {
    expect(extractChatId('')).toBeNull();
    expect(extractChatId('hello')).toBeNull();
    expect(extractChatId('acabox://chat/')).toBeNull();
    expect(extractChatId(123 as unknown as string)).toBeNull();
  });

  it('isChatLink is true only for the link form, not a bare id', () => {
    expect(isChatLink(`acabox://chat/${A}`)).toBe(true);
    expect(isChatLink(A)).toBe(false);
    expect(isChatLink(`https://example.com/${A}`)).toBe(false);
  });
});

describe('splitTextByChatLinks', () => {
  it('interleaves text runs and chat parts in order', () => {
    expect(splitTextByChatLinks(`look at acabox://chat/${A} then acabox://chat/${B}!`)).toEqual([
      { type: 'text', text: 'look at ' },
      { type: 'chat', sessionId: A, raw: `acabox://chat/${A}` },
      { type: 'text', text: ' then ' },
      { type: 'chat', sessionId: B, raw: `acabox://chat/${B}` },
      { type: 'text', text: '!' },
    ]);
  });

  it('returns one text run when there are no links, and [] for empty input', () => {
    expect(splitTextByChatLinks('plain')).toEqual([{ type: 'text', text: 'plain' }]);
    expect(splitTextByChatLinks('')).toEqual([]);
  });

  it('a link alone is a single chat part', () => {
    expect(splitTextByChatLinks(`acabox://chat/${A}`)).toEqual([
      { type: 'chat', sessionId: A, raw: `acabox://chat/${A}` },
    ]);
  });
});

describe('reference block for the agent', () => {
  const ref = (over: Partial<ChatRef> = {}): ChatRef => ({
    sessionId: A,
    exists: true,
    title: 'Cost Breakdown Visualization and Analysis Tool',
    appDirName: 'coScientistSpendExplorer',
    messageCount: 101,
    lastMessageAt: '2026-09-18T07:40:38.067',
    ...over,
  });

  it('formats a stored SQLite timestamp for humans and passes odd values through', () => {
    expect(formatStoredAt('2026-09-18T07:40:38.067')).toBe('2026-09-18 07:40 UTC');
    expect(formatStoredAt(null)).toBe('never');
    expect(formatStoredAt('yesterday')).toBe('yesterday');
  });

  it('describes an existing chat with title, count, tool and last activity', () => {
    expect(describeChatRef(ref())).toBe(
      `- acabox://chat/${A} — "Cost Breakdown Visualization and Analysis Tool" — 101 messages · tool coScientistSpendExplorer · last active 2026-09-18 07:40 UTC`,
    );
  });

  it('omits the tool for a general chat, singularises one message, handles an untitled chat', () => {
    const line = describeChatRef(ref({ appDirName: null, messageCount: 1, title: '  ' }));
    expect(line).toContain('(untitled chat)');
    expect(line).toContain('1 message ·');
    expect(line).not.toContain('tool ');
  });

  it('says plainly when the id matches nothing', () => {
    expect(describeChatRef(ref({ exists: false }))).toMatch(/no chat with this id exists/);
  });

  it('composeChatRefsText is a no-op with no refs and appends a block otherwise', () => {
    expect(composeChatRefsText('hi', [])).toBe('hi');
    const out = composeChatRefsText('what did we decide there?\n', [ref()]);
    expect(out.startsWith('what did we decide there?\n\nReferenced chats')).toBe(true);
    expect(out).toContain('read_chat');
    expect(out).toContain(`- acabox://chat/${A}`);
  });

  it('a message that is only a link still produces the block', () => {
    expect(composeChatRefsText('', [ref()]).startsWith('Referenced chats')).toBe(true);
  });
});
