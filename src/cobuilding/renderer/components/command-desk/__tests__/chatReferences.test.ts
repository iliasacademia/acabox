import { matchAtTrigger } from '../atMention';
import { filterChats, type ChatIndexEntry } from '../chatIndex';

describe('matchAtTrigger', () => {
  it('opens on a bare @ at the start or after a space', () => {
    expect(matchAtTrigger('@')).toEqual({ query: '', atIndex: 0 });
    expect(matchAtTrigger('see @')).toEqual({ query: '', atIndex: 4 });
  });

  it('carries what has been typed after the @ as the filter', () => {
    expect(matchAtTrigger('see @dna')).toEqual({ query: 'dna', atIndex: 4 });
  });

  it('allows spaces inside the query, because chat titles have them', () => {
    expect(matchAtTrigger('@dna sequence')).toEqual({ query: 'dna sequence', atIndex: 0 });
  });

  it('does NOT open on an email address', () => {
    // The `@` in `ilias@academia.edu` is not preceded by whitespace.
    expect(matchAtTrigger('write to ilias@academia')).toBeNull();
  });

  it('closes rather than showing every chat when @ is used as the word "at"', () => {
    // A query that STARTS with a space would otherwise be trimmed to empty and
    // list all chats, next to a sentence that has nothing to do with them.
    expect(matchAtTrigger('meet @ 5pm')).toBeNull();
    expect(matchAtTrigger('meet @ ')).toBeNull();
  });

  it('only matches at the caret, not anywhere earlier in the line', () => {
    expect(matchAtTrigger('@dna and then some other words.')).toBeNull();
  });

  it('gives up on a run long enough to be prose rather than a title', () => {
    expect(matchAtTrigger(`@${'x'.repeat(60)}`)).toBeNull();
  });
});

describe('filterChats', () => {
  const entry = (id: string, title: string, updatedAt: string): ChatIndexEntry =>
    ({ id, title, updatedAt, appDirName: null });
  const all = [
    entry('a', 'DNA Sequence Analysis', '2026-09-01'),
    entry('b', 'Hex HTTP 403', '2026-09-03'),
    entry('c', 'dna reverse complement', '2026-09-02'),
  ];

  it('lists most recently active first when there is no query', () => {
    expect(filterChats(all, '').map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('matches titles case-insensitively, still newest first', () => {
    expect(filterChats(all, 'DNA').map((e) => e.id)).toEqual(['c', 'a']);
  });

  it('excludes the chat doing the asking', () => {
    // A thread offering to reference itself is an invitation to spend a
    // retrieval reading what is already in context.
    expect(filterChats(all, '', 'b').map((e) => e.id)).toEqual(['c', 'a']);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(filterChats(all, 'zzz')).toEqual([]);
  });
});
