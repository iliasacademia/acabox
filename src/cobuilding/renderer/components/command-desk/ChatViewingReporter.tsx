import { useEffect } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { reportViewingChat } from '../../chatActivityStore';

/**
 * Tells main which conversation this surface has on screen, so a turn that
 * finishes while you are reading it is not flagged unread — and one that
 * finishes while you are elsewhere is.
 *
 * `visible` must be the surface's REAL visibility, not its mountedness: every
 * tab stays mounted behind `display:none`, which is exactly why this cannot be
 * inferred on the main side. Main ANDs it with window focus.
 */
export function ChatViewingReporter({ surface, visible }: { surface: string; visible: boolean }) {
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  useEffect(() => {
    reportViewingChat(surface, visible && remoteId ? remoteId : null);
    return () => reportViewingChat(surface, null);
  }, [surface, visible, remoteId]);
  return null;
}
