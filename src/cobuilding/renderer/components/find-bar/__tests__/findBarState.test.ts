import {
  applyResult,
  applyText,
  formatCount,
  initialFindBarState,
  type FindBarState,
} from '../findBarState';
import type { FindResult } from '../../../../shared/findInPage';

describe('initialFindBarState', () => {
  it('starts empty and settled', () => {
    expect(initialFindBarState).toEqual({ text: '', ordinal: 0, matches: 0, settled: true });
  });
});

describe('applyText', () => {
  it('sets the text and marks the state unsettled while awaiting a result', () => {
    const next = applyText(initialFindBarState, 'abc');
    expect(next).toEqual({ text: 'abc', ordinal: 0, matches: 0, settled: false });
  });

  it('resets to the zero state and settles when the text is cleared', () => {
    const withResult: FindBarState = { text: 'abc', ordinal: 2, matches: 5, settled: true };
    const next = applyText(withResult, '');
    expect(next).toEqual({ text: '', ordinal: 0, matches: 0, settled: true });
  });

  it('preserves the prior ordinal/matches while typing a new query (until a result arrives)', () => {
    const withResult: FindBarState = { text: 'abc', ordinal: 2, matches: 5, settled: true };
    const next = applyText(withResult, 'abcd');
    expect(next).toEqual({ text: 'abcd', ordinal: 2, matches: 5, settled: false });
  });
});

describe('applyResult', () => {
  it('is ignored (state returned unchanged) once the input has been cleared', () => {
    const cleared: FindBarState = { text: '', ordinal: 0, matches: 0, settled: true };
    const result: FindResult = { activeMatchOrdinal: 1, matches: 3, finalUpdate: true };
    expect(applyResult(cleared, result)).toBe(cleared);
  });

  it('adopts ordinal/matches/settled from the result while a query is active', () => {
    const state: FindBarState = { text: 'abc', ordinal: 0, matches: 0, settled: false };
    const result: FindResult = { activeMatchOrdinal: 2, matches: 5, finalUpdate: true };
    expect(applyResult(state, result)).toEqual({ text: 'abc', ordinal: 2, matches: 5, settled: true });
  });

  it('renders an incremental (non-final) update as unsettled', () => {
    const state: FindBarState = { text: 'abc', ordinal: 0, matches: 0, settled: false };
    const result: FindResult = { activeMatchOrdinal: 1, matches: 2, finalUpdate: false };
    expect(applyResult(state, result)).toEqual({ text: 'abc', ordinal: 1, matches: 2, settled: false });
  });
});

describe('formatCount', () => {
  it('is empty when the text is empty', () => {
    expect(formatCount({ text: '', ordinal: 0, matches: 0, settled: true })).toBe('');
  });

  it('renders "N of M" when there are matches, including incremental (unsettled) updates', () => {
    expect(formatCount({ text: 'abc', ordinal: 2, matches: 5, settled: true })).toBe('2 of 5');
    expect(formatCount({ text: 'abc', ordinal: 1, matches: 3, settled: false })).toBe('1 of 3');
  });

  it('renders "No matches" once settled with zero matches', () => {
    expect(formatCount({ text: 'abc', ordinal: 0, matches: 0, settled: true })).toBe('No matches');
  });

  it('renders nothing while still searching (zero matches, not yet settled)', () => {
    expect(formatCount({ text: 'abc', ordinal: 0, matches: 0, settled: false })).toBe('');
  });
});
