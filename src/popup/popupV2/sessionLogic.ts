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
 * Clear only on doc → different-doc transitions. Critically, do NOT
 * clear on doc → null transitions: those happen on every Cmd+Tab away
 * from Word (the WebSocket poll reports `activeDocumentPath = null`
 * when Word isn't the foreground app), and clearing there would lose
 * the user's session every time they briefly switch apps.
 */
export function shouldClearActiveOnDocChange(
  prevDocPath: string | null,
  newDocPath: string | null,
): boolean {
  return prevDocPath !== null && newDocPath !== null && prevDocPath !== newDocPath;
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
 *   - workspaceSessions is empty (could be a brand-new doc, or pollData
 *     hasn't fully populated yet)
 *   - activeSession is null (nothing to clear)
 *   - workspaceSessions includes the active id (legitimately belongs)
 */
export function isActiveSessionStaleForDoc(
  activeSessionId: string | null,
  workspaceSessions: ReadonlyArray<WorkspaceSession>,
): boolean {
  if (activeSessionId === null) return false;
  if (workspaceSessions.length === 0) return false;
  return !workspaceSessions.some((s) => s.id === activeSessionId);
}
