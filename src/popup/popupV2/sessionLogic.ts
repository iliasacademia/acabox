/**
 * Pure decision functions for the overlay's session-selection state machine.
 *
 * Lives in its own module so each rule can be unit-tested without mounting
 * the overlay React component or wiring up jsdom + WebSocket polling. The
 * component (`AcademiaNotificationsPopupV2`) wraps these with the React
 * state and side-effect glue; the rules themselves are intentionally pure.
 *
 * Together they enforce the convergence guarantees we want between the
 * overlay and the desktop "Chats" tab:
 *   - Cmd+Tab away from Word doesn't lose the active session.
 *   - Auto-open never overrides a session the user is already typing in.
 *   - Sessions the overlay already moved past don't get re-yanked on remount.
 *   - Kickoff (Open in Word) reuses the doc's most-recent session instead
 *     of minting a UUID the desktop side never sees.
 */

export interface WorkspaceSession {
  id: string;
  title: string;
  created_at: string;
}

/**
 * Auto-open guard: a fresh (just-created) session pulls the user into
 * it ONLY when there's no active session. Once they're inside a thread,
 * pollData chatter — WebSocket reconnects, fresh sessions the desktop
 * happens to create, focus changes — must NOT switch them.
 */
export function shouldAutoOpenFreshSession(
  activeSessionId: string | null,
  freshSession: WorkspaceSession | null,
): boolean {
  return freshSession !== null && activeSessionId === null;
}

/**
 * Find the most-recent session in the list that's inside the freshness
 * window AND hasn't already been auto-opened. Sessions the overlay has
 * already moved past stay marked so returning to the list later doesn't
 * re-yank back in.
 *
 * Malformed `created_at` values are skipped, not treated as "now" — that
 * matters because the alternative would silently auto-open garbage data.
 */
export function findAutoOpenCandidate(
  sessions: ReadonlyArray<WorkspaceSession>,
  alreadyOpened: ReadonlySet<string>,
  nowMs: number,
  maxAgeMs: number,
): WorkspaceSession | null {
  for (const s of sessions) {
    if (alreadyOpened.has(s.id)) continue;
    const createdMs = Date.parse(s.created_at);
    if (Number.isFinite(createdMs) && nowMs - createdMs < maxAgeMs) {
      return s;
    }
  }
  return null;
}

/**
 * Should we clear the active session because the user switched docs?
 *
 * Clear only on id → different-id transitions. Critically, do NOT
 * clear on id → null transitions: those happen on every Cmd+Tab away
 * from Word (the WebSocket poll reports null when Word isn't the
 * foreground app), and clearing there would lose the user's session
 * every time they briefly switch apps.
 */
export function shouldClearActiveOnDocChange(
  prevFileId: string | null,
  newFileId: string | null,
): boolean {
  return prevFileId !== null && newFileId !== null && prevFileId !== newFileId;
}

/**
 * After a pollData arrival, decide whether `activeSession` belongs to
 * the document we're currently focused on. The overlay persists
 * `activeSession` to localStorage so it survives window close/reopen,
 * which means it can resurrect for the wrong doc if the user closed the
 * overlay on docA and then reopened it focused on docB. If pollData has
 * authoritative `workspaceSessions` for the current doc and the active
 * session isn't in that list, the active session is stale.
 *
 * Returns true ONLY when we're confident the active session doesn't
 * belong to the focused doc — callers should NOT clear when:
 *   - activeSession is null (nothing to clear)
 *   - workspaceSessions includes the active id (legitimately belongs)
 *
 * An empty `workspaceSessions` list is authoritative: the server checked
 * the DB and found no sessions for this document. The caller already
 * excludes locally-created sessions (via `localSessionIdRef`), so a
 * non-local active session absent from an empty list is genuinely stale.
 */
export function isActiveSessionStaleForDoc(
  activeSessionId: string | null,
  workspaceSessions: ReadonlyArray<WorkspaceSession>,
): boolean {
  if (activeSessionId === null) return false;
  return !workspaceSessions.some((s) => s.id === activeSessionId);
}

/**
 * Returns an updated title for the active session if it changed in the
 * latest workspaceSessions poll data. Returns null if no update needed.
 *
 * Used after title generation: the server updates the DB title and emits
 * a poll refresh. The overlay's active session stores the title from when
 * it was opened (often "New Chat"). This helper detects the mismatch and
 * returns the new title so the component can update reactively.
 */
export function getUpdatedActiveSessionTitle(
  activeSession: { id: string; title: string } | null,
  workspaceSessions: ReadonlyArray<WorkspaceSession>,
): string | null {
  if (!activeSession) return null;
  const updated = workspaceSessions.find(s => s.id === activeSession.id);
  if (updated && updated.title && updated.title !== activeSession.title) {
    return updated.title;
  }
  return null;
}

/**
 * Minimal interface a runtime needs to expose for `refreshActiveThread`
 * to force a reload. Lets the helper be tested without mounting a real
 * assistant-ui runtime — the production caller adapts the runtime's
 * concrete `threads` object to this shape.
 */
export interface ThreadSwitcher {
  switchToThread(id: string): void;
  switchToNewThread(): void;
  getThreadIds(): ReadonlyArray<string>;
}

/**
 * Force the runtime to re-mount the active thread so its history adapter
 * runs again and the freshly-arrived DB messages appear in the view.
 *
 * The original implementation called `runtime.threads.switchToThread(id)`
 * with the already-active id, which assistant-ui short-circuits as a
 * no-op — so the thread component never re-mounted and the cached
 * history stuck. That's why the second consecutive overlay → desktop
 * replication failed: the first arrival happened to land while the
 * thread was freshly mounted (history.load already ran), but subsequent
 * arrivals had no mechanism to force re-load.
 *
 * The fix: switch AWAY (to any other thread, or a scratch new one if
 * none exist), then switch BACK. The thread component unmounts on the
 * first switch and re-mounts on the second, which is what makes the
 * runtime call history.load() afresh.
 */
export function refreshActiveThread(switcher: ThreadSwitcher, sessionId: string): void {
  const others = switcher.getThreadIds().filter((id) => id !== sessionId);
  if (others.length > 0) {
    switcher.switchToThread(others[0]);
  } else {
    switcher.switchToNewThread();
  }
  switcher.switchToThread(sessionId);
}

/**
 * Should the overlay auto-open a blank chat for an empty workspace?
 *
 * When a document is in a workspace but has zero sessions, the overlay
 * should default to a fresh blank chat (composer + welcome) rather than
 * showing an empty list. Returns true when all three conditions hold:
 *   1. The document is in a workspace (`isInWorkspace`)
 *   2. There are no existing sessions (`sessionsCount === 0`)
 *   3. No session is currently active (`activeSessionId === null`)
 *
 * Callers must BOTH set the active session AND show it (hide the list)
 * when this returns true — forgetting the latter leaves the blank chat
 * mounted but hidden behind the (now-empty) sessions list view.
 */
export function shouldAutoOpenBlankChat(
  isInWorkspace: boolean,
  sessionsCount: number,
  activeSessionId: string | null,
): boolean {
  return isInWorkspace && sessionsCount === 0 && activeSessionId === null;
}

/**
 * Should an incoming SSE / IPC chat-event trigger a foreign-refresh?
 *
 * The server emits two interesting cross-surface events: `done` (assistant
 * turn finished) and `user-message` (a user message just landed in the DB
 * from another surface). On the receiving surface, both are signals to
 * reload the thread's history so the new content shows up.
 *
 * `isRunning` gates both: when the receiving surface is itself driving the
 * turn, the local runtime is already streaming the response into the view,
 * so a foreign-refresh would just cause a flash. When `isRunning` is false,
 * the event is unambiguously from somewhere else and a refresh is needed.
 *
 * Pure function so the routing decision can be unit-tested without
 * mounting the React component or wiring up an EventSource.
 */
export function shouldRefreshOnForeignEvent(
  eventName: string,
  eventPayload: unknown,
  isRunningLocally: boolean,
): boolean {
  if (isRunningLocally) return false;
  if (eventName === 'done') return true;
  if (eventName === 'event') {
    const data = eventPayload as { type?: unknown } | null;
    if (data && typeof data === 'object' && data.type === 'user-message') {
      return true;
    }
  }
  return false;
}
