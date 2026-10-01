import { rankSearchRows } from '../chatSearchRank';

/**
 * Pure ranking rules for the Chats-page search box. See
 * docs/design/chat-search.md § Ticket B.
 */

type Item = { remoteId?: string; title?: string };

function hit(sessionId: string, total = 1): ChatProseResultData {
  return {
    sessionId,
    total,
    hits: [{ messageId: 1, role: 'user', createdAt: '2026-01-01T00:00:00.000Z', snippet: 'a snippet' }],
  };
}

function prose(entries: Array<[string, ChatProseResultData]>): ReadonlyMap<string, ChatProseResultData> {
  return new Map(entries);
}

describe('rankSearchRows', () => {
  it('returns nothing for an empty (or whitespace-only) query', () => {
    const items: Record<string, Item> = { t1: { remoteId: 's1', title: 'anything' } };
    expect(rankSearchRows(['t1'], items, '', new Map())).toEqual([]);
    expect(rankSearchRows(['t1'], items, '   ', new Map())).toEqual([]);
  });

  it('puts title matches before prose-only matches regardless of list position', () => {
    const threadIds = ['t1', 't2'];
    const items: Record<string, Item> = {
      t1: { remoteId: 's1', title: 'random name' }, // prose-only, first in the list
      t2: { remoteId: 's2', title: 'contains KEYWORD here' }, // title match, second in the list
    };
    const rows = rankSearchRows(threadIds, items, 'keyword', prose([['s1', hit('s1')]]));
    expect(rows.map((r) => r.sessionId)).toEqual(['s2', 's1']);
    expect(rows[0].titleMatch).toBe(true);
    expect(rows[1].titleMatch).toBe(false);
  });

  it('keeps the list order within each group', () => {
    const threadIds = ['a', 'b', 'c', 'd'];
    const items: Record<string, Item> = {
      a: { remoteId: 'sa', title: 'no match' },
      b: { remoteId: 'sb', title: 'has term' },
      c: { remoteId: 'sc', title: 'also has term' },
      d: { remoteId: 'sd', title: 'no match either' },
    };
    const rows = rankSearchRows(threadIds, items, 'term', prose([['sa', hit('sa')], ['sd', hit('sd')]]));
    // Title group (b, c) in list order, then prose-only group (a, d) in list order.
    expect(rows.map((r) => r.sessionId)).toEqual(['sb', 'sc', 'sa', 'sd']);
  });

  it('a row matching both title and prose appears once, in the title group, with its prose attached', () => {
    const h = hit('s1', 4);
    const rows = rankSearchRows(['t1'], { t1: { remoteId: 's1', title: 'term in title' } }, 'term', prose([['s1', h]]));
    expect(rows).toHaveLength(1);
    expect(rows[0].titleMatch).toBe(true);
    expect(rows[0].prose).toBe(h);
  });

  it('skips thread ids with no remoteId (the unstarted "new thread" entry)', () => {
    const threadIds = ['t1', 't2'];
    const items: Record<string, Item> = {
      t1: { title: 'term' }, // no remoteId
      t2: { remoteId: 's2', title: 'term' },
    };
    const rows = rankSearchRows(threadIds, items, 'term', new Map());
    expect(rows.map((r) => r.threadId)).toEqual(['t2']);
  });

  it('title matching is case-insensitive', () => {
    const rows = rankSearchRows(['t1'], { t1: { remoteId: 's1', title: 'Big DATA' } }, 'data', new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0].titleMatch).toBe(true);
  });

  it('treats a missing title as "New chat"', () => {
    const rows = rankSearchRows(['t1'], { t1: { remoteId: 's1' } }, 'new chat', new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0].titleMatch).toBe(true);
  });

  it('excludes a row that matches neither the title nor any prose result', () => {
    const rows = rankSearchRows(['t1'], { t1: { remoteId: 's1', title: 'unrelated' } }, 'term', new Map());
    expect(rows).toEqual([]);
  });
});
