/**
 * Force a thread's history adapter to re-fetch from SQLite and merge the
 * new state into assistant-ui's repository.
 *
 * assistant-ui's `LocalThreadRuntimeCore` caches `load()` in `_loadPromise`
 * and only calls the adapter once per thread per runtime lifetime. By
 * clearing that field and re-invoking `__internal_load()`, the adapter is
 * called again; `repository.import()` then upserts the messages so any
 * blocks the agent persisted while the user was elsewhere become visible
 * without a remount.
 *
 * **Race protection.** When a user sends from a fresh thread, the renderer
 * commits U1 and A1 to the in-memory repo synchronously, but the chat:send
 * IPC that inserts U1 into SQLite is asynchronous. If a reload fires in
 * that window, `listMessages` returns an empty array, `repository.import`
 * calls `resetHead(null)` → `clear()`, wipes U1 and A1, and the in-flight
 * `performRoundtrip` crashes with "Parent message not found" on the next
 * `updateMessage`. To dodge that without blocking the legitimate case
 * (returning to a thread the agent has been writing to all along), we
 * pre-fetch from SQLite ourselves and skip the import only when SQLite is
 * empty. Any non-empty result is safe — at worst `import` orphans the
 * in-memory A1, but U1 stays present and the run continues.
 */
export async function reloadThreadHistory(runtime: any, threadId: string): Promise<void> {
  try {
    const threadsCore = runtime?._core?.threads;
    const threadCore = threadsCore?.getThreadRuntimeCore?.(threadId)
      ?? threadsCore?._threads?.get?.(threadId)
      ?? null;
    if (!threadCore) {
      window.debugAPI.log(`[ReloadThreadHistory] threadId=${threadId} skipped — no thread core`);
      return;
    }
    const dbMessages = await window.sessionsAPI.listMessages(threadId);
    if (dbMessages.length === 0) {
      window.debugAPI.log(`[ReloadThreadHistory] threadId=${threadId} skipped — SQLite empty (likely mid-send before insert lands)`);
      return;
    }
    threadCore._loadPromise = null;
    // `__internal_load` returns the Promise that resolves after
    // `repository.import` runs (see LocalThreadRuntimeCore). Callers that
    // need to act on the freshly-imported tail (e.g. parent a new
    // resumeRun to it) must await this rather than the kickoff.
    await threadCore.__internal_load?.();
    window.debugAPI.log(`[ReloadThreadHistory] threadId=${threadId} reloaded (sqlite=${dbMessages.length} rows)`);
  } catch (err) {
    console.warn('[ReloadThreadHistory] failed', err);
  }
}
