import { useMemo } from 'react';
import {
  useAuiState,
  ExportedMessageRepository,
} from '@assistant-ui/react';
import type { ThreadHistoryAdapter } from '@assistant-ui/react';

import { convertHistoryMessagesFromStringContent } from './historyMessageConverter';

/**
 * Desktop history adapter. Reads stored messages from the local SQLite
 * (via Electron IPC) and converts them through the shared converter so
 * the desktop and overlay surfaces produce identical output for the
 * same DB rows. See `historyMessageConverter.ts` for the conversion logic.
 */
export function useThreadHistoryAdapter(): ThreadHistoryAdapter {
  const remoteId = useAuiState((s: any) => s.threadListItem.remoteId) as string | undefined;

  return useMemo(
    (): ThreadHistoryAdapter => ({
      async load() {
        if (!remoteId) {
          window.debugAPI.log('[HistoryAdapter] load remoteId=null count=0');
          return ExportedMessageRepository.fromArray([]);
        }
        // IPC returns rows whose `content` column is still a JSON string.
        const dbMessages = await window.sessionsAPI.listMessages(remoteId);
        const messages = convertHistoryMessagesFromStringContent(dbMessages);
        window.debugAPI.log(`[HistoryAdapter] load remoteId=${remoteId} count=${messages.length}`);
        return ExportedMessageRepository.fromArray(messages);
      },

      async append() {},
    }),
    [remoteId],
  );
}
