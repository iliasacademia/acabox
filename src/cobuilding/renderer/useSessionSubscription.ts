import { useEffect, useRef, useState } from 'react';
import { useAssistantRuntime, useThreadRuntime, useAuiState } from '@assistant-ui/react';
import type { ChatStreamMessage } from '../shared/types';
import { resetProgress } from './progressStore';
import { responseBuilder, toAsyncIterable } from './chatAdapter';
import { reloadThreadHistory } from './reloadThreadHistory';

const IDLE_TIMEOUT_MS = 60_000;

/**
 * Subscribes to agent session events for the active thread and routes them
 * into assistant-ui via `resumeRun`. Two entry conditions, gated by
 * `chatAPI.isTurnInProgress` + the local `thread.isRunning`:
 *
 *   - **Idle thread**: subscribe and wait for the first event (foreign
 *     turn started by overlay etc.), then `resumeRun`.
 *   - **Reattach mid-turn**: the user navigated away while a local
 *     chatAdapter run was streaming, then came back. chatAdapter's
 *     generator returned (assistant-ui drops runs across
 *     `switchToNewThread`), but its stream iterator stays registered in
 *     preload's `activeStreams`, so a plain `subscribe` would defer to
 *     the orphan and return a no-op. We force-subscribe to evict the
 *     orphan, reload SQLite so the new `resumeRun` is parented to the
 *     consolidated tail (without this each cycle stacks an in-flight
 *     onto the previous one), and start the run eagerly.
 *
 * After the inner generator exits (turn-complete / abort / cancel), only
 * the takeover path re-pulls SQLite to keep the chats-list view in sync
 * with the SQLite-backed views (tools-list, sessions API). When
 * chatAdapter is the driver, its own yields produced an already-consistent
 * in-memory state and a reload would clobber it.
 *
 * Idle-timeout (60s) tears down on long silence; `sessions:changed` bumps
 * an epoch to re-subscribe after that, so overlay-initiated turns that
 * arrive late still get picked up.
 */
export function useSessionSubscription() {
  const runtime = useAssistantRuntime();
  const threadRuntime = useThreadRuntime();
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  // Captured at effect-fire time. Keeping `isRunning` out of deps avoids
  // churning the subscription on every transition.
  const isRunningRef = useRef(false);
  isRunningRef.current = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;
  const [subscriptionEpoch, setSubscriptionEpoch] = useState(0);

  useEffect(() => {
    if (!remoteId) return;
    return window.sessionsAPI.onSessionsChanged(() => {
      setSubscriptionEpoch((e) => e + 1);
    });
  }, [remoteId]);

  useEffect(() => {
    if (!remoteId) return;

    let cancelled = false;
    let started = false;
    let driving = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const cleanupLocal = () => {
      cancelled = true;
      if (idleTimer) clearTimeout(idleTimer);
      unsubscribe?.();
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(cleanupLocal, IDLE_TIMEOUT_MS);
    };

    void (async () => {
      const serverTurnInProgress = await window.chatAPI.isTurnInProgress(remoteId);
      if (cancelled) return;
      const takeover = serverTurnInProgress && !isRunningRef.current;

      const sub = window.chatAPI.subscribe(remoteId, takeover ? { force: true } : undefined);
      unsubscribe = sub.unsubscribe;
      if (cancelled) { sub.unsubscribe(); return; }
      resetIdleTimer();

      const iterable = toAsyncIterable(sub.stream);
      const response = responseBuilder();

      // Resolved by the inner generator on exit. We need to act after the
      // generator finishes — doing the post-turn reload earlier would race
      // the import against final yields and orphan them.
      let generatorDoneResolve: (() => void) | null = null;
      const generatorDone = new Promise<void>((r) => { generatorDoneResolve = r; });

      const startResumeRun = (firstMsg: ChatStreamMessage | null) => {
        if (started) return;
        started = true;
        driving = true;
        if (firstMsg) response.onMessage(firstMsg);
        try {
          const messages = threadRuntime.getState().messages;
          const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
          threadRuntime.resumeRun({
            parentId: lastMessageId,
            stream: async function* ({ abortSignal }) {
              const onAbort = () => window.chatAPI.stopResponding(remoteId!);
              abortSignal.addEventListener('abort', onAbort, { once: true });
              try {
                yield { content: response.getContent() };
                for await (const nextMsg of iterable) {
                  if (abortSignal.aborted || cancelled) break;
                  resetIdleTimer();
                  response.onMessage(nextMsg);
                  yield { content: response.getContent() };
                  if (nextMsg.type === 'turn-complete') break;
                }
              } finally {
                abortSignal.removeEventListener('abort', onAbort);
                generatorDoneResolve?.();
              }
            },
          });
        } catch {
          // Concurrent local run beat us to it — let it drive.
          driving = false;
          generatorDoneResolve?.();
        }
      };

      if (takeover) {
        window.debugAPI.log(`[useSessionSubscription] takeover for ${remoteId}`);
        // Reload before resumeRun so the new in-flight message is parented
        // to the consolidated SQLite tail. fromArray generates fresh IDs,
        // which moves any prior takeover chain into an orphan branch and
        // resets the rendered lineage to U1 → A_merged → A_inflight.
        await reloadThreadHistory(runtime, remoteId);
        if (cancelled) return;
        startResumeRun(null);
      } else {
        for await (const msg of iterable) {
          if (cancelled) break;
          resetIdleTimer();
          startResumeRun(msg);
          break;
        }
      }

      if (!driving) return;

      await generatorDone;
      if (cancelled || isRunningRef.current) return;
      // The generator may have exited because a new local chatAdapter run
      // claimed the stream — re-verify before clobbering its in-flight state.
      const stillRunning = await window.chatAPI.isTurnInProgress(remoteId);
      if (cancelled || isRunningRef.current || stillRunning) return;
      window.debugAPI.log(`[useSessionSubscription] turn ended for ${remoteId} — reloading SQLite`);
      await reloadThreadHistory(runtime, remoteId);
    })();

    return () => {
      cleanupLocal();
      // Drops the registry's visibility refcount; local cleanup alone only
      // tears down the renderer stream.
      window.chatAPI.unsubscribe(remoteId);
      resetProgress();
    };
  }, [remoteId, threadRuntime, runtime, subscriptionEpoch]);
}
