/**
 * Pure state for the find bar's input/result rendering. Kept dependency-free
 * (no Electron, no React) so it's trivially unit-testable; `FindBar.tsx` is
 * the only consumer. Contract: src/cobuilding/shared/findInPage.ts.
 */
import type { FindResult } from '../../../shared/findInPage';

export interface FindBarState {
  text: string;
  ordinal: number;
  matches: number;
  settled: boolean;
}

export const initialFindBarState: FindBarState = {
  text: '',
  ordinal: 0,
  matches: 0,
  settled: true,
};

/** Typing in the input. Empty text resets to the settled zero state (a clear, not a search). */
export function applyText(state: FindBarState, text: string): FindBarState {
  if (text === '') {
    return { text: '', ordinal: 0, matches: 0, settled: true };
  }
  return { ...state, text, settled: false };
}

/**
 * A `found-in-page` result relayed from main. Ignored (state returned
 * unchanged) once the input has been cleared — a stale result for a query
 * that's no longer live must not resurrect a count next to an empty box.
 */
export function applyResult(state: FindBarState, result: FindResult): FindBarState {
  if (state.text === '') return state;
  return {
    ...state,
    ordinal: result.activeMatchOrdinal,
    matches: result.matches,
    settled: result.finalUpdate,
  };
}

export function formatCount(state: FindBarState): string {
  if (state.text === '') return '';
  if (state.matches > 0) return `${state.ordinal} of ${state.matches}`;
  if (state.matches === 0 && state.settled) return 'No matches';
  return '';
}
