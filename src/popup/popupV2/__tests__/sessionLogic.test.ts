/**
 * Edge-case coverage for the overlay's session-selection state machine.
 *
 * The overlay (`AcademiaNotificationsPopupV2`) used to lose the active
 * session on every Cmd+Tab away from Word, re-yank the user into stale
 * sessions on remount, and override mid-conversation activeSession on
 * any pollData update that surfaced a fresher session. The pure
 * helpers in `../sessionLogic.ts` enforce the invariants those bugs
 * violated; these tests pin each invariant with the failure scenarios
 * that originally hit users.
 *
 * Multi-session model assumed throughout: the overlay supports many
 * sessions per docx, and the desktop chat tab supports many sessions
 * in general. The convergence guarantee is "the user's active
 * session must not change underneath them," not "one session per docx."
 */

import {
  shouldAutoOpenFreshSession,
  findAutoOpenCandidate,
  shouldClearActiveOnDocChange,
  isActiveSessionStaleForDoc,
  shouldRefreshOnForeignEvent,
  refreshActiveThread,
  WorkspaceSession,
  ThreadSwitcher,
} from '../sessionLogic';

const session = (id: string, createdAtIso: string, title = id): WorkspaceSession => ({
  id,
  title,
  created_at: createdAtIso,
});

describe('shouldAutoOpenFreshSession', () => {
  const fresh = session('FRESH', '2026-05-07T12:00:00Z');

  it('opens a fresh session when no session is active (Case 4 cold start)', () => {
    expect(shouldAutoOpenFreshSession(null, fresh)).toBe(true);
  });

  it('refuses to override an active session (Case 2 mid-conversation Cmd+Tab)', () => {
    // Bug pre-fix: overlay would switch to any fresh session in pollData
    // even when the user was actively typing in another. This is the single
    // most important invariant — focus chatter must not change the room
    // the user is in.
    expect(shouldAutoOpenFreshSession('active-id', fresh)).toBe(false);
  });

  it('returns false when no fresh session arrived', () => {
    expect(shouldAutoOpenFreshSession(null, null)).toBe(false);
    expect(shouldAutoOpenFreshSession('active-id', null)).toBe(false);
  });
});

describe('findAutoOpenCandidate', () => {
  const NOW = Date.parse('2026-05-07T12:00:00Z');
  const FRESH = 10_000;

  it('finds a session created within the freshness window', () => {
    const sessions = [session('A', '2026-05-07T11:59:55Z')]; // 5s ago
    const result = findAutoOpenCandidate(sessions, new Set(), NOW, FRESH);
    expect(result?.id).toBe('A');
  });

  it('skips sessions older than the freshness window', () => {
    const sessions = [session('A', '2026-05-07T11:00:00Z')]; // 1h ago
    expect(findAutoOpenCandidate(sessions, new Set(), NOW, FRESH)).toBeNull();
  });

  it('skips sessions already in the auto-opened set (Case 1 back-to-list dedup)', () => {
    // The bug pre-fix was that this set lived in a useRef, which reset on
    // every popup hide/show. Persisting via localStorage means the user's
    // "I left this session, leave me alone" intent survives focus cycles.
    const sessions = [session('A', '2026-05-07T11:59:55Z')];
    expect(findAutoOpenCandidate(sessions, new Set(['A']), NOW, FRESH)).toBeNull();
  });

  it('returns null on empty list', () => {
    expect(findAutoOpenCandidate([], new Set(), NOW, FRESH)).toBeNull();
  });

  it('skips malformed created_at entries instead of treating them as "now"', () => {
    // A session row with junk in created_at must NOT be picked. The
    // alternative — falling through to Date.parse() = NaN treated like
    // a fresh hit — would silently auto-open garbage data.
    const sessions = [
      session('A', 'not a date'),
      session('B', '2026-05-07T11:59:55Z'),
    ];
    const result = findAutoOpenCandidate(sessions, new Set(), NOW, FRESH);
    expect(result?.id).toBe('B');
  });

  it('returns the first fresh, unseen session in iteration order', () => {
    // Server returns sessions ordered however it wants — we don't sort here;
    // the auto-open is for "the brand-new one the desktop just made," and
    // pollData typically lists newest first. Pinning iteration-order
    // dependence makes regressions visible.
    const sessions = [
      session('OLDEST', '2026-05-07T10:00:00Z'),
      session('FRESH_1', '2026-05-07T11:59:58Z'),
      session('FRESH_2', '2026-05-07T11:59:55Z'),
    ];
    const result = findAutoOpenCandidate(sessions, new Set(), NOW, FRESH);
    expect(result?.id).toBe('FRESH_1');
  });
});

describe('shouldClearActiveOnDocChange', () => {
  it('clears on doc → different doc (Case 5 Word doc switch)', () => {
    expect(shouldClearActiveOnDocChange('/a.docx', '/b.docx')).toBe(true);
  });

  it('does NOT clear on doc → null — the Cmd+Tab fix', () => {
    // The bug pre-fix: every Cmd+Tab away from Word made
    // activeDocumentPath go null (poll reports null when Word isn't
    // foreground). The doc-change effect treated that as a doc switch
    // and wiped activeSession. Tab back → null → doc transition didn't
    // re-clear, but the original session was already gone.
    expect(shouldClearActiveOnDocChange('/a.docx', null)).toBe(false);
  });

  it('does NOT clear on null → doc (initial focus / overlay first mount)', () => {
    expect(shouldClearActiveOnDocChange(null, '/a.docx')).toBe(false);
  });

  it('does NOT clear on null → null (focus moves between non-doc apps)', () => {
    expect(shouldClearActiveOnDocChange(null, null)).toBe(false);
  });

  it('does NOT clear when the path is unchanged', () => {
    expect(shouldClearActiveOnDocChange('/a.docx', '/a.docx')).toBe(false);
  });
});

describe('isActiveSessionStaleForDoc', () => {
  it('flags an active session whose ID is not in the current doc\'s session list (Case 6)', () => {
    // The cross-doc stale-localStorage case: user closes overlay on docA
    // session A1, opens it on docB. activeSession hydrates as A1 from
    // localStorage but workspaceSessions is for docB and doesn't include
    // A1. The overlay would otherwise display A1's messages while
    // claiming to be the chat for docB.
    expect(
      isActiveSessionStaleForDoc('A1', [session('B1', '2026-05-07T12:00:00Z')]),
    ).toBe(true);
  });

  it('does NOT flag when the active session is in the workspace list (legitimate)', () => {
    expect(
      isActiveSessionStaleForDoc('A1', [
        session('A1', '2026-05-07T12:00:00Z'),
        session('A2', '2026-05-07T13:00:00Z'),
      ]),
    ).toBe(false);
  });

  it('does NOT flag when no active session exists', () => {
    expect(isActiveSessionStaleForDoc(null, [session('A1', '2026-05-07T12:00:00Z')])).toBe(false);
  });

  it('does NOT flag when workspaceSessions is empty (could be brand-new doc OR pre-pollData)', () => {
    // Critical: an empty list might mean the doc has no sessions yet,
    // OR it might mean pollData hasn't populated yet. Clearing in
    // either case would either prevent legitimate cold-start auto-open
    // (former) or destroy the active session during a connect race
    // (latter). Returning false here defers the decision to a later
    // tick when we have real data.
    expect(isActiveSessionStaleForDoc('A1', [])).toBe(false);
  });
});

describe('shouldRefreshOnForeignEvent', () => {
  // The cross-surface refresh trigger. A `done` event always means
  // "another surface finished a turn"; a generic `event` only triggers
  // refresh when its payload type is `user-message` (a user message
  // landed in the DB from another surface — refresh so the user turn
  // shows up before the assistant streams its reply). isRunning gates
  // both: when WE are the originating surface, our local runtime is
  // already feeding the view and a refresh would just flash.

  it('refreshes on a foreign `done` event when not running locally', () => {
    expect(shouldRefreshOnForeignEvent('done', null, false)).toBe(true);
  });

  it('refreshes on a foreign user-message event when not running locally', () => {
    expect(shouldRefreshOnForeignEvent('event', { type: 'user-message', text: 'hi' }, false)).toBe(true);
  });

  it('does NOT refresh on `done` while running locally (we are the originator)', () => {
    // The user typed in this surface; our /send is already streaming the
    // reply through the local runtime. A foreign-refresh here would tear
    // down our in-flight runtime view.
    expect(shouldRefreshOnForeignEvent('done', null, true)).toBe(false);
  });

  it('does NOT refresh on a user-message event while running locally', () => {
    expect(shouldRefreshOnForeignEvent('event', { type: 'user-message', text: 'hi' }, true)).toBe(false);
  });

  it('does NOT refresh on assistant-side stream events (text-delta, tool-call, etc.)', () => {
    // Assistant-side events are handled by the live stream subscription —
    // they should not trigger a thread re-mount. Refresh fires only on
    // turn-completion or user-message arrival.
    expect(shouldRefreshOnForeignEvent('event', { type: 'text-delta', text: 'foo' }, false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('event', { type: 'tool-call', toolCallId: 't1', toolName: 'f', args: {}, argsText: '' }, false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('event', { type: 'thinking-delta', text: 'x' }, false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('event', { type: 'heartbeat' }, false)).toBe(false);
  });

  it('does NOT refresh on a malformed payload', () => {
    // EventSource handlers receive untrusted text — JSON.parse may
    // succeed with garbage, or the handler may pass null on parse
    // failure. Either way, no recognized type → no refresh.
    expect(shouldRefreshOnForeignEvent('event', null, false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('event', undefined, false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('event', 'not an object', false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('event', {}, false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('event', { type: 42 }, false)).toBe(false);
  });

  it('does NOT refresh on unknown SSE event names', () => {
    // The SSE channel may carry events we don't recognize (heartbeat,
    // future additions). Default to no-refresh rather than thrashing
    // the thread on every unknown event.
    expect(shouldRefreshOnForeignEvent('error', null, false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('keepalive', null, false)).toBe(false);
    expect(shouldRefreshOnForeignEvent('', null, false)).toBe(false);
  });
});

/**
 * Reproduction of the consecutive-foreign-event bug.
 *
 * Symptom (from a real session screenshot): first overlay → desktop
 * user message replicated correctly. Subsequent overlay → desktop
 * messages stopped appearing in the desktop view, even though the
 * server was broadcasting `chat:foreign-done` and the desktop's
 * handler was firing.
 *
 * Cause (verified by reading the original handler in
 * `src/cobuilding/renderer/index.tsx`): the refresh code finished by
 * calling `runtime.threads.switchToThread(sessionId)` where sessionId
 * was already the active thread. assistant-ui short-circuits same-id
 * switches as no-ops, so the thread component never re-mounted and
 * the runtime's cached history adapter result was never re-fetched.
 * The first foreign event happened to land while the thread had just
 * been freshly mounted (history.load had run naturally on activation),
 * giving the false impression that the refresh worked. Every event
 * after that hit the cache and silently no-op'd.
 *
 * The test below asserts the call SHAPE that's required to actually
 * force a re-mount (switch away → switch back). The original code
 * would only produce a single same-id call, which the test pins as
 * a no-op shape so any regression to the single-call form is loud.
 */
describe('refreshActiveThread (foreign-event remount fix)', () => {
  function recordingSwitcher(threadIds: string[]): ThreadSwitcher & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      switchToThread: (id: string) => calls.push(`switch:${id}`),
      switchToNewThread: () => calls.push('new'),
      getThreadIds: () => threadIds,
    };
  }

  it('switches AWAY to another existing thread, then back — forcing the thread to re-mount', () => {
    const sw = recordingSwitcher(['A', 'B', 'C']);
    refreshActiveThread(sw, 'B');
    // Two calls in this order: away (any non-target id) then back to target.
    // The "away" + "back" pair is what unmounts and remounts the thread
    // component, which is what causes the runtime to re-call history.load().
    expect(sw.calls).toEqual(['switch:A', 'switch:B']);
  });

  it('creates a scratch new thread and switches back when only the target thread exists', () => {
    // Edge case: a workspace with exactly one thread. There's no other
    // thread to switch to, so we briefly create a new scratch thread,
    // which makes the original thread unmount. Then switch back forces
    // its re-mount. Trade-off documented in the helper docstring.
    const sw = recordingSwitcher(['ONLY']);
    refreshActiveThread(sw, 'ONLY');
    expect(sw.calls).toEqual(['new', 'switch:ONLY']);
  });

  it('reproduces the original bug: a single same-id switch produces no remount', () => {
    // The original handler at renderer/index.tsx:272 ran:
    //   runtime.threads.switchToThread(sessionId)
    // where sessionId was the currently active thread. Capturing that
    // exact call sequence here demonstrates that it's a single same-id
    // switch with no away/back pairing — which assistant-ui short-circuits
    // and which the new helper explicitly avoids.
    const sw = recordingSwitcher(['CURRENT']);
    sw.switchToThread('CURRENT');
    expect(sw.calls).toEqual(['switch:CURRENT']);
    expect(sw.calls.length).toBe(1);

    // The fix: same scenario, run through refreshActiveThread instead.
    sw.calls.length = 0;
    refreshActiveThread(sw, 'CURRENT');
    expect(sw.calls).toEqual(['new', 'switch:CURRENT']);
    expect(sw.calls.length).toBe(2);
  });

  it('back-switch is always last (so the user lands on the original thread)', () => {
    // Whatever path we take to force the unmount, the FINAL call must
    // restore the active thread to the original session — otherwise the
    // user would be visually yanked into the scratch / sibling thread.
    const sw1 = recordingSwitcher(['A', 'B']);
    refreshActiveThread(sw1, 'B');
    expect(sw1.calls[sw1.calls.length - 1]).toBe('switch:B');

    const sw2 = recordingSwitcher(['ONLY']);
    refreshActiveThread(sw2, 'ONLY');
    expect(sw2.calls[sw2.calls.length - 1]).toBe('switch:ONLY');
  });
});
