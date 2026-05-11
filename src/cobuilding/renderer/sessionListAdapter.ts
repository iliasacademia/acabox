import type { RemoteThreadListAdapter } from '@assistant-ui/react';
import { replaceSessionTimestampsFromList, setSessionCreatedAt, setSessionDocumentPath } from './sessionTimestamps';

// Tracks which session IDs are currently running (processing).
// Updated on every list() call and on sessions:changed events.
let _runningSessionIds = new Set<string>();
export function isSessionRunning(sessionId: string): boolean {
  return _runningSessionIds.has(sessionId);
}
export async function refreshRunningIds(): Promise<void> {
  try {
    const ids = await window.sessionsAPI.getRunningIds();
    _runningSessionIds = new Set(ids);
  } catch {
    // Ignore — API might not be available yet
  }
}

export const sessionListAdapter: RemoteThreadListAdapter = {
  async list() {
    const [sessions] = await Promise.all([
      window.sessionsAPI.list(),
      refreshRunningIds(),
    ]);
    replaceSessionTimestampsFromList(sessions);
    return {
      threads: sessions.map((s) => ({
        status: 'regular' as const,
        remoteId: s.id,
        title: s.title,
      })),
    };
  },

  async initialize() {
    const remoteId = crypto.randomUUID();
    return { remoteId, externalId: undefined };
  },

  async rename(remoteId: string, newTitle: string) {
    await window.sessionsAPI.rename(remoteId, newTitle);
  },

  async delete(remoteId: string) {
    await window.sessionsAPI.delete(remoteId);
  },

  async archive() {},

  async unarchive() {},

  async generateTitle() {
    return new ReadableStream();
  },

  async fetch(threadId: string) {
    const session = await window.sessionsAPI.get(threadId);
    if (session) {
      setSessionCreatedAt(session.id, session.created_at);
      setSessionDocumentPath(session.id, session.document_path ?? null);
    }
    return {
      status: 'regular' as const,
      remoteId: threadId,
      title: session?.title,
    };
  },
};
