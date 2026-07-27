import { useEffect, useState } from 'react';
import {
  formatEffortLabel,
  formatModelLabel,
  getSelectedEffortLabel,
  getSelectedModelLabel,
} from '../ModelSelector';

/**
 * Per-conversation metadata the chat surfaces display: the model/effort the
 * chat is pinned to, and the mini-app it belongs to.
 *
 * Read straight from the host rather than the assistant-ui thread list, which
 * doesn't carry these fields. The pin is written mid-turn (the model comes from
 * the Agent SDK's init event), so callers pass a `refreshKey` — typically the
 * thread's `isRunning` flag — to refetch when a turn ends.
 */
export interface SessionMeta {
  model: string | null;
  effort: string | null;
  appDirName: string | null;
}

const EMPTY: SessionMeta = { model: null, effort: null, appDirName: null };

export function useSessionMeta(remoteId: string | undefined, refreshKey?: unknown): SessionMeta {
  const [meta, setMeta] = useState<SessionMeta>(EMPTY);

  useEffect(() => {
    if (!remoteId) { setMeta(EMPTY); return; }
    let cancelled = false;
    window.sessionsAPI.get(remoteId).then((session) => {
      if (cancelled) return;
      setMeta(
        session
          ? {
            model: session.model ?? null,
            effort: session.effort ?? null,
            appDirName: session.app_dir_name ?? null,
          }
          : EMPTY,
      );
    }).catch(() => {
      if (!cancelled) setMeta(EMPTY);
    });
    return () => { cancelled = true; };
  }, [remoteId, refreshKey]);

  return meta;
}

/**
 * The "MODEL · EFFORT" line for a chat header.
 *
 * A chat that has already run a turn shows what it is pinned to. An empty chat
 * has no pin yet, so it shows the picker's current selection — which is what
 * its first turn will actually use. A chat that ran before model pinning
 * existed has nothing recorded and shows nothing, rather than guessing.
 */
export function formatSessionModelMeta(meta: SessionMeta, isEmptyChat: boolean): string | null {
  if (meta.model) {
    const model = formatModelLabel(meta.model);
    return meta.effort ? `${model} · ${formatEffortLabel(meta.effort)}` : model;
  }
  if (isEmptyChat) return `${getSelectedModelLabel()} · ${getSelectedEffortLabel()}`;
  return null;
}
