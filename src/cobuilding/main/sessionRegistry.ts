import log from 'electron-log';
import { captureError } from '../shared/telemetry';
import type { AgentSession } from './agentSession';

/**
 * Session kind controls the cleanup policy:
 *
 *  - `'ui'`        — chat sessions tied to a visible surface (desktop chat,
 *                    overlay). Eligible for visibility-based eviction: when
 *                    every subscriber detaches and the session is not running,
 *                    it is destroyed. If running, destroy is deferred until
 *                    the next turn completes.
 *
 *  - `'background'`— headless sessions (scheduled tasks, calendar agent).
 *                    They run without a visible chat surface and are
 *                    responsible for their own lifecycle via the onDone /
 *                    onError callbacks they registered at creation.
 */
export type SessionKind = 'ui' | 'background';

interface Entry {
  session: AgentSession;
  kind: SessionKind;
  pendingDestroy: boolean;
  detachDoneListener: () => void;
}

const entries = new Map<string, Entry>();
// Subscribers are tracked independently of session existence so an overlay
// (SSE) or desktop renderer that opens before the first user message — i.e.
// before the agent session is registered — is still counted once it's
// created. Without this, the just-created session would look like it has
// zero subscribers and be destroyed the moment any one of them detached.
const subscribers = new Map<string, Set<string>>();

export function registerSession(id: string, session: AgentSession, kind: SessionKind = 'ui'): void {
  const prior = entries.get(id);
  if (prior) {
    log.warn(`[SessionRegistry] registerSession(${id}) replacing existing entry; destroying prior`);
    prior.detachDoneListener();
    prior.session.destroy();
  }

  const entry: Entry = {
    session,
    kind,
    pendingDestroy: false,
    detachDoneListener: () => {},
  };

  // Re-check eligibility on two signals:
  //   - 'turn-complete' event: the agent loop is still alive but a turn
  //     just ended. This is the primary deferred-destroy trigger because
  //     a streaming-input query() never ends naturally between turns.
  //   - onDone: the whole session loop ended (server-side idle eviction,
  //     /stop, crash). Catches the edge case where the loop ends without
  //     a turn ever completing.
  // In both cases, if a subscriber detached while we were mid-turn,
  // pendingDestroy is set and there are still no subscribers, this is
  // the moment to tear down.
  const maybeFireDeferredDestroy = (reason: string) => {
    const current = entries.get(id);
    if (!current) return;
    if (current.pendingDestroy && subscriberCount(id) === 0) {
      log.info(`[SessionRegistry] Deferred destroy firing for ${id} (${reason}, still no subscribers)`);
      destroyEntry(id);
    }
  };
  entry.detachDoneListener = session.addListener({
    onEvent: (msg) => {
      if (msg.type === 'turn-complete') {
        maybeFireDeferredDestroy('turn finished');
      }
    },
    onDone: () => {
      maybeFireDeferredDestroy('session loop ended');
    },
  });

  entries.set(id, entry);
}

export function unregisterSession(id: string): void {
  destroyEntry(id);
}

export function getRegisteredSession(id: string): AgentSession | undefined {
  return entries.get(id)?.session;
}

export function hasSession(id: string): boolean {
  return entries.has(id);
}

export function destroyAllSessions(): void {
  for (const id of [...entries.keys()]) {
    destroyEntry(id);
  }
}

/**
 * Mark a surface as actively interested in `sessionId`. `key` must uniquely
 * identify the subscriber across its full lifetime — typically `ipc:<senderId>`
 * for an Electron webContents subscriber, or `sse:<seq>` for an HTTP SSE
 * stream. addSubscriber is idempotent for the same key.
 *
 * Adding a subscriber clears any pending visibility-based destroy: a user
 * who navigated away and then back before the current turn finished should
 * not have their session yanked out from under them.
 *
 * Tracked even when no session is currently registered for `sessionId` —
 * the count is consulted when a session is later created or destroyed.
 */
export function addSubscriber(sessionId: string, key: string): void {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  set.add(key);
  const entry = entries.get(sessionId);
  if (entry?.pendingDestroy) {
    log.info(`[SessionRegistry] Subscriber ${key} reattached to ${sessionId}; cancelling deferred destroy`);
    entry.pendingDestroy = false;
  }
}

/**
 * Detach a surface. When the last subscriber leaves a `'ui'` session, the
 * cleanup policy fires:
 *
 *   - not currently running → destroy now
 *   - currently running     → mark pendingDestroy, wait for the next onDone
 *
 * `'background'` sessions ignore subscriber count entirely.
 */
export function removeSubscriber(sessionId: string, key: string): void {
  const set = subscribers.get(sessionId);
  if (!set) return;
  if (!set.delete(key)) return;
  if (set.size === 0) subscribers.delete(sessionId);

  const entry = entries.get(sessionId);
  if (!entry) return;
  if (subscriberCount(sessionId) > 0) return;
  if (entry.kind !== 'ui') return;

  // Per-turn busy state, not the session-lifetime `isRunning` flag (which
  // stays true across turns and so would never let a deferred destroy fire).
  if (entry.session.isTurnInProgress) {
    log.info(`[SessionRegistry] ${sessionId} has no subscribers but a turn is in progress; deferring destroy until turn-complete`);
    entry.pendingDestroy = true;
  } else {
    log.info(`[SessionRegistry] ${sessionId} has no subscribers and is idle; destroying`);
    destroyEntry(sessionId);
  }
}

function subscriberCount(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}

function destroyEntry(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  // Also clear any pre-session subscribers tracked for this id, otherwise
  // the map grows unboundedly when a thread is destroyed without each of
  // its surfaces detaching first.
  subscribers.delete(id);
  entry.detachDoneListener();
  try {
    entry.session.destroy();
  } catch (err) {
    log.error(`[SessionRegistry] destroy(${id}) threw:`, err);
    captureError(err, { subsystem: 'agent', extra: { phase: 'session_destroy', session_id: id } });
  }
}
