/**
 * `chatRefResolver.ts` is pure and dependency-injected, so these run against
 * fake lookups — no database, no mocks.
 */
import { resolveChatRefs, type ChatRefLookup } from '../chatRefResolver';
import { composeChatRefsText, buildChatLink } from '../../shared/chatLinks';

const WORKSPACE = 'workspace-1';
const OTHER_WORKSPACE = 'workspace-2';
const CURRENT_SESSION = '00000000-0000-0000-0000-000000000000';

const A = '14027f7d-6112-42c0-9d63-b420467d490c';
const B = '2cf62d69-7262-4bbe-8470-97dfab88cae0';
const C = '3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';

function fakeLookup(overrides: Partial<ChatRefLookup> = {}): ChatRefLookup {
  const sessions = new Map<string, { workspace_id: string; title: string; app_dir_name: string | null }>([
    [A, { workspace_id: WORKSPACE, title: 'Cost Breakdown Visualization and Analysis Tool', app_dir_name: 'coScientistSpendExplorer' }],
    [B, { workspace_id: OTHER_WORKSPACE, title: 'A chat in a different workspace', app_dir_name: null }],
  ]);
  const activity = new Map<string, { messageCount: number; lastMessageAt: string | null }>([
    [A, { messageCount: 101, lastMessageAt: '2026-09-18T07:40:38.067' }],
  ]);
  return {
    getSession: (id: string) => sessions.get(id),
    getActivity: (id: string) => activity.get(id) ?? { messageCount: 0, lastMessageAt: null },
    ...overrides,
  };
}

describe('resolveChatRefs', () => {
  it('resolves an existing chat with title, appDirName, messageCount, lastMessageAt', () => {
    const text = `see ${buildChatLink(A)}`;
    const refs = resolveChatRefs(text, CURRENT_SESSION, WORKSPACE, fakeLookup());
    expect(refs).toEqual([
      {
        sessionId: A,
        exists: true,
        title: 'Cost Breakdown Visualization and Analysis Tool',
        appDirName: 'coScientistSpendExplorer',
        messageCount: 101,
        lastMessageAt: '2026-09-18T07:40:38.067',
      },
    ]);
  });

  it('an id with no session at all resolves to exists:false with null/0 fields', () => {
    const refs = resolveChatRefs(`see ${buildChatLink(C)}`, CURRENT_SESSION, WORKSPACE, fakeLookup());
    expect(refs).toEqual([
      { sessionId: C, exists: false, title: null, appDirName: null, messageCount: 0, lastMessageAt: null },
    ]);
  });

  it('a session belonging to a different workspace resolves to exists:false and leaks no title', () => {
    const refs = resolveChatRefs(`see ${buildChatLink(B)}`, CURRENT_SESSION, WORKSPACE, fakeLookup());
    expect(refs).toEqual([
      { sessionId: B, exists: false, title: null, appDirName: null, messageCount: 0, lastMessageAt: null },
    ]);
    const serialized = JSON.stringify(refs);
    expect(serialized).not.toContain('different workspace');
  });

  it('drops the current session\'s own link and collapses duplicates (parseChatLinks already dedupes)', () => {
    const text = `self ${buildChatLink(CURRENT_SESSION)} and again ${buildChatLink(A)} and ${buildChatLink(A)}`;
    const refs = resolveChatRefs(text, CURRENT_SESSION, WORKSPACE, fakeLookup());
    expect(refs).toHaveLength(1);
    expect(refs[0].sessionId).toBe(A);
  });

  it('caps at the first 8 of 9 distinct links, in order', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `1111111${i}-0000-0000-0000-00000000000${i}`);
    const text = ids.map(buildChatLink).join(' ');
    const lookup: ChatRefLookup = {
      getSession: (id: string) => ({ workspace_id: WORKSPACE, title: `Chat ${id}`, app_dir_name: null }),
      getActivity: () => ({ messageCount: 1, lastMessageAt: null }),
    };
    const refs = resolveChatRefs(text, CURRENT_SESSION, WORKSPACE, lookup);
    expect(refs).toHaveLength(8);
    expect(refs.map((r) => r.sessionId)).toEqual(ids.slice(0, 8));
  });

  it('a lookup that throws resolves that ref to exists:false while the others still resolve', () => {
    const lookup = fakeLookup({
      getSession: (id: string) => {
        if (id === A) throw new Error('boom');
        return { workspace_id: WORKSPACE, title: 'Fine', app_dir_name: null };
      },
    });
    const text = `${buildChatLink(A)} ${buildChatLink(C)}`;
    const refs = resolveChatRefs(text, CURRENT_SESSION, WORKSPACE, lookup);
    expect(refs).toEqual([
      { sessionId: A, exists: false, title: null, appDirName: null, messageCount: 0, lastMessageAt: null },
      { sessionId: C, exists: true, title: 'Fine', appDirName: null, messageCount: 0, lastMessageAt: null },
    ]);
  });

  it('text with no links resolves to []', () => {
    expect(resolveChatRefs('just some plain text', CURRENT_SESSION, WORKSPACE, fakeLookup())).toEqual([]);
  });

  it('end to end: composeChatRefsText over the resolved refs contains the title and link and starts with the typed text', () => {
    const typed = `what did we decide there? ${buildChatLink(A)}`;
    const refs = resolveChatRefs(typed, CURRENT_SESSION, WORKSPACE, fakeLookup());
    const out = composeChatRefsText(typed, refs);
    expect(out.startsWith(typed)).toBe(true);
    expect(out).toContain('Cost Breakdown Visualization and Analysis Tool');
    expect(out).toContain(buildChatLink(A));
  });
});
