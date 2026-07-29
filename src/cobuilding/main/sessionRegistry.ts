import log from 'electron-log';
import { captureError } from '../shared/telemetry';
import {
  OAUTH_FLOW_WINDOW_MS,
  MCP_AUTHENTICATE_TOOL,
  MCP_COMPLETE_AUTH_TOOL,
} from '../shared/oauthWindow';
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
  /** Non-null while this session is pinned. Holds the expiry timer and the
   *  reason, so an expiry can log what it was waiting for. See pinSession. */
  pin: { reason: string; timer: NodeJS.Timeout } | null;
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
    // A pin belongs to a specific CLI subprocess. The replacement session is a
    // different process with an empty flow map, so the old pin protects
    // nothing — drop it here rather than let its timer outlive the entry.
    clearPin(prior, 'session replaced');
    prior.detachDoneListener();
    prior.session.destroy();
  }

  const entry: Entry = {
    session,
    kind,
    pendingDestroy: false,
    detachDoneListener: () => {},
    pin: null,
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
    if (current.pin) {
      log.info(`[SessionRegistry] ${id} would be destroyed (${reason}) but is pinned: ${current.pin.reason}`);
      return;
    }
    if (current.pendingDestroy && subscriberCount(id) === 0) {
      log.info(`[SessionRegistry] Deferred destroy firing for ${id} (${reason}, still no subscribers)`);
      destroyEntry(id);
    }
  };

  // Connector OAuth pin. An `mcp__<id>__authenticate` call leaves a handshake
  // pending inside the CLI subprocess this session owns — the callback
  // listener and PKCE verifier exist nowhere else — and the turn ends as soon
  // as the authorization URL is handed to the user. Without a pin the process
  // dies before they can click it, which is exactly the bug this fixes.
  //
  // Watching the event stream is the cheapest correct trigger: the registry is
  // already a listener, so no new plumbing and no import cycle with
  // agentSession. The tradeoff is that session lifetime is coupled to a tool
  // NAME — if the SDK ever renames these tools the pin silently stops arming,
  // and the symptom is the original bug returning. The regression test guards
  // the predicate, not the SDK's naming.
  const pendingCompleteAuthCalls = new Set<string>();
  entry.detachDoneListener = session.addListener({
    onEvent: (msg) => {
      if (msg.type === 'tool-call') {
        if (MCP_AUTHENTICATE_TOOL.test(msg.toolName)) {
          pinSession(id, `${msg.toolName} awaiting browser callback`);
        } else if (MCP_COMPLETE_AUTH_TOOL.test(msg.toolName)) {
          pendingCompleteAuthCalls.add(msg.toolCallId);
        }
      } else if (msg.type === 'tool-result' && pendingCompleteAuthCalls.delete(msg.toolCallId)) {
        // The manual-paste fallback has run. Redeemed or rejected, the wait is
        // over — release early rather than holding a subprocess for the
        // remainder of the window.
        unpinSession(id, 'manual completion returned');
      } else if (msg.type === 'turn-complete') {
        maybeFireDeferredDestroy('turn finished');
      }
    },
    onDone: () => {
      // The loop ended under us (server-side idle eviction, /stop, crash).
      // Whatever the pin was protecting is gone with it, so drop it rather
      // than leave a timer holding a dead entry.
      clearPin(entries.get(id), 'session loop ended');
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

  // A pin outranks visibility. The user is in their browser finishing a
  // sign-in — navigating away from the chat, or the renderer's own
  // unsubscribe/re-subscribe churn at turn end, must not kill the process
  // holding their half-finished handshake.
  //
  // Record the destroy as OWED rather than just skipping it. A pin defers
  // eviction, it does not cancel it: without this the entry survives its own
  // pin release (onDone clears the pin, then finds pendingDestroy false and
  // leaves a dead session in the map forever). `addSubscriber` clears the flag
  // if the user comes back, which is the behaviour we want.
  if (entry.pin) {
    log.info(`[SessionRegistry] ${sessionId} has no subscribers but is pinned (${entry.pin.reason}); deferring destroy`);
    entry.pendingDestroy = true;
    return;
  }

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

/**
 * Hold `sessionId` open past the point where visibility rules would evict it,
 * for at most OAUTH_FLOW_WINDOW_MS.
 *
 * The expiry timer is not a safety net, it is the primary release. The thing a
 * pin protects — a pending OAuth handshake — usually completes in the user's
 * browser, which sends Acabox no signal at all; the CLI's own listener takes
 * the redirect. So in the successful case nothing ever calls unpinSession, and
 * a pin without a hard expiry would keep an API-key-bearing subprocess alive
 * for the rest of the app's life. The window matches the CLI's own 300s flow
 * ceiling exactly: past it the flow is dead anyway and holding the process
 * buys nothing.
 *
 * Re-pinning an already-pinned session restarts the clock rather than stacking
 * timers — the agent calling `authenticate` a second time aborts the CLI's
 * first flow and starts a fresh one, so the new window is the correct one.
 */
export function pinSession(sessionId: string, reason: string): void {
  const entry = entries.get(sessionId);
  if (!entry) {
    log.warn(`[SessionRegistry] pinSession(${sessionId}) ignored: no such session`);
    return;
  }
  if (entry.pin) {
    clearTimeout(entry.pin.timer);
    log.info(`[SessionRegistry] Re-pinning ${sessionId} (${reason}); previous window discarded`);
  } else {
    log.info(`[SessionRegistry] Pinning ${sessionId} for ${OAUTH_FLOW_WINDOW_MS}ms: ${reason}`);
  }
  const timer = setTimeout(() => {
    const current = entries.get(sessionId);
    if (!current || current.pin?.timer !== timer) return;
    current.pin = null;
    log.info(`[SessionRegistry] Pin expired for ${sessionId} (${reason})`);
    // Expiry is the moment the eviction we suppressed becomes due again.
    // Re-run the same policy removeSubscriber would have: nobody watching and
    // nothing in flight means nothing is left to keep.
    if (subscriberCount(sessionId) === 0 && current.kind === 'ui' && !current.session.isTurnInProgress) {
      log.info(`[SessionRegistry] ${sessionId} still has no subscribers after pin expiry; destroying`);
      destroyEntry(sessionId);
    }
  }, OAUTH_FLOW_WINDOW_MS);
  // Do not hold the event loop open purely to expire a pin.
  timer.unref?.();
  entry.pin = { reason, timer };
}

/**
 * Release a pin early. Safe to call on an unpinned or unknown session.
 * Does NOT itself evict — the next detach (or the turn-complete hook) applies
 * the normal policy, and evicting here would race a subscriber that is still
 * attached.
 */
export function unpinSession(sessionId: string, reason: string): void {
  clearPin(entries.get(sessionId), reason);
}

/** Test seam: is this session currently pinned, and why. */
export function getSessionPinReason(sessionId: string): string | null {
  return entries.get(sessionId)?.pin?.reason ?? null;
}

function clearPin(entry: Entry | undefined, reason: string): void {
  if (!entry?.pin) return;
  clearTimeout(entry.pin.timer);
  log.info(`[SessionRegistry] Unpinning (${reason}); was: ${entry.pin.reason}`);
  entry.pin = null;
}

function destroyEntry(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  if (entry.pin) clearTimeout(entry.pin.timer);
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
