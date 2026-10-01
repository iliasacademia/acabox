import {
  dateFromSessionStoredAt,
  getSessionUpdatedAt,
  replaceSessionTimestampsFromList,
} from '../sessionTimestamps';

describe('dateFromSessionStoredAt', () => {
  it('reads a zone-less SQLite timestamp as UTC', () => {
    expect(dateFromSessionStoredAt('2026-09-22T10:00:00.000').toISOString()).toBe('2026-09-22T10:00:00.000Z');
  });
  it('leaves an explicit zone alone', () => {
    expect(dateFromSessionStoredAt('2026-09-22T10:00:00Z').toISOString()).toBe('2026-09-22T10:00:00.000Z');
  });
});

describe('last-activity date for the Chats list', () => {
  it('is the session updated_at, not created_at', () => {
    replaceSessionTimestampsFromList([
      { id: 'a', created_at: '2026-09-01T00:00:00.000', updated_at: '2026-09-28T12:00:00.000' },
    ]);
    expect(getSessionUpdatedAt('a')).toBe('2026-09-28T12:00:00.000');
  });
});
