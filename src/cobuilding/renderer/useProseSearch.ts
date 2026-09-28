import { useEffect, useRef, useState } from 'react';

/**
 * Debounced `sessions:searchProse` for the Chats-page search box. See
 * `docs/design/chat-search.md` § Ticket B.
 *
 * The query the user is typing is not what gets sent on every keystroke — a
 * 150ms debounce coalesces a run of keystrokes into one request, and a
 * sequence counter drops a response that is no longer for the latest query
 * (a slower earlier request answering after a faster later one must not
 * overwrite it). Results are held across a pending request — no per-keystroke
 * flicker back to empty — and a rejected call simply leaves them as they are.
 *
 * While a query is active, `sessions:changed` re-runs it immediately (not
 * debounced): a chat that stopped matching (deleted, edited) should drop out
 * without waiting for another keystroke.
 *
 * Imports nothing from `@assistant-ui/react`, so it renders under jest.
 */

const DEBOUNCE_MS = 150;

const EMPTY_RESULTS: ReadonlyMap<string, ChatProseResultData> = new Map();
const EMPTY_STATE: ProseSearchState = { forQuery: '', results: EMPTY_RESULTS };

export interface ProseSearchState {
  /** The query the current `results` answer. '' means "no results yet / empty query". */
  forQuery: string;
  results: ReadonlyMap<string, ChatProseResultData>;
}

function toMap(rows: ChatProseResultData[] | null | undefined): ReadonlyMap<string, ChatProseResultData> {
  const map = new Map<string, ChatProseResultData>();
  if (Array.isArray(rows)) {
    for (const row of rows) map.set(row.sessionId, row);
  }
  return map;
}

export function useProseSearch(query: string): ProseSearchState {
  const trimmed = query.trim();
  const [state, setState] = useState<ProseSearchState>(EMPTY_STATE);
  // Bumped on every distinct query so a response for an earlier one — however
  // it resolves relative to a later one — is recognised as stale and dropped.
  const seqRef = useRef(0);

  useEffect(() => {
    if (!trimmed) {
      seqRef.current += 1;
      setState(EMPTY_STATE);
      return;
    }

    const mySeq = ++seqRef.current;
    let cancelled = false;

    function run(): void {
      try {
        window.sessionsAPI?.searchProse?.(trimmed).then((rows) => {
          if (cancelled || mySeq !== seqRef.current) return; // superseded
          setState({ forQuery: trimmed, results: toMap(rows) });
        }).catch(() => { /* keep the previous results on screen */ });
      } catch { /* bridge absent (tests, early boot) */ }
    }

    const timer = setTimeout(run, DEBOUNCE_MS);
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.sessionsAPI?.onSessionsChanged?.(run);
    } catch { /* bridge absent */ }

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [trimmed]);

  return state;
}
