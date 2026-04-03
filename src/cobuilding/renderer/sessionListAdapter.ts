import type { RemoteThreadListAdapter } from '@assistant-ui/react';

export const sessionListAdapter: RemoteThreadListAdapter = {
  async list() {
    const sessions = await window.sessionsAPI.list();
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
    return {
      status: 'regular' as const,
      remoteId: threadId,
      title: session?.title,
    };
  },
};
