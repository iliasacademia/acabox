import { KernelManager, ServerConnection } from '@jupyterlab/services';
import type { IKernelConnection } from '@jupyterlab/services/lib/kernel/kernel';
import type { IIOPubMessage } from '@jupyterlab/services/lib/kernel/messages';
import { Signal } from '@lumino/signaling';
import type { CellOutput } from './types';

export type KernelStatus = 'disconnected' | 'starting' | 'idle' | 'busy' | 'dead';

export interface KernelEntrySnapshot {
  status: KernelStatus;
  error: string | null;
  kernelName: string;
}

interface KernelEntry {
  kernel: IKernelConnection;
  manager: KernelManager;
  kernelName: string;
  status: KernelStatus;
  error: string | null;
  listeners: Set<Listener>;
}

type Listener = (snap: KernelEntrySnapshot) => void;

class KernelRegistry {
  private entries = new Map<string, KernelEntry>();
  private starting = new Map<string, Promise<KernelEntrySnapshot>>();
  private pendingListeners = new Map<string, Set<Listener>>();
  private pendingSnapshots = new Map<string, KernelEntrySnapshot>();
  private gatewayUrl: string | null = null;

  private snapshot(entry: KernelEntry): KernelEntrySnapshot {
    return { status: entry.status, error: entry.error, kernelName: entry.kernelName };
  }

  private getPendingSnapshot(key: string): KernelEntrySnapshot {
    return (
      this.pendingSnapshots.get(key) ?? {
        status: 'disconnected',
        error: null,
        kernelName: 'python3',
      }
    );
  }

  private updatePending(key: string, patch: Partial<KernelEntrySnapshot>): void {
    const current = this.getPendingSnapshot(key);
    const next = { ...current, ...patch };
    this.pendingSnapshots.set(key, next);
    const listeners = this.pendingListeners.get(key);
    if (listeners) {
      for (const cb of listeners) cb(next);
    }
  }

  private notify(entry: KernelEntry): void {
    const snap = this.snapshot(entry);
    for (const cb of entry.listeners) cb(snap);
  }

  /**
   * Remove `key` from entries, migrate listeners to pendingListeners so a
   * subsequent connect() picks them back up, and seed pendingSnapshot with the
   * entry's last known state. Returns the evicted entry so the caller can
   * dispose resources.
   */
  private evictEntry(key: string): KernelEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    if (entry.listeners.size > 0) {
      let pending = this.pendingListeners.get(key);
      if (!pending) {
        pending = new Set();
        this.pendingListeners.set(key, pending);
      }
      for (const cb of entry.listeners) pending.add(cb);
      entry.listeners.clear();
    }
    this.pendingSnapshots.set(key, this.snapshot(entry));
    return entry;
  }

  get(key: string): KernelEntrySnapshot | null {
    const entry = this.entries.get(key);
    return entry ? this.snapshot(entry) : null;
  }

  subscribe(key: string, cb: Listener): () => void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.listeners.add(cb);
      cb(this.snapshot(entry));
    } else {
      let pending = this.pendingListeners.get(key);
      if (!pending) {
        pending = new Set();
        this.pendingListeners.set(key, pending);
      }
      pending.add(cb);
      cb(this.getPendingSnapshot(key));
    }
    return () => {
      // Listener may have been migrated between entry and pending across
      // connect/evict cycles — try both locations.
      this.entries.get(key)?.listeners.delete(cb);
      const pending = this.pendingListeners.get(key);
      if (pending) {
        pending.delete(cb);
        if (pending.size === 0) this.pendingListeners.delete(key);
      }
    };
  }

  async connect(key: string, kernelName?: string): Promise<KernelEntrySnapshot> {
    const existing = this.entries.get(key);
    // No explicit name → preserve whatever kernel was last used for this key.
    const resolvedName =
      kernelName ??
      existing?.kernelName ??
      this.pendingSnapshots.get(key)?.kernelName ??
      'python3';

    if (existing && existing.kernelName === resolvedName && existing.status !== 'dead') {
      return this.snapshot(existing);
    }

    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;

    const promise = this.startKernel(key, resolvedName).finally(() => {
      this.starting.delete(key);
    });
    this.starting.set(key, promise);
    return promise;
  }

  private async startKernel(key: string, kernelName: string): Promise<KernelEntrySnapshot> {
    this.updatePending(key, { status: 'starting', error: null, kernelName });

    // Shut down any stale entry (different kernelName, dead, etc.) — migrate
    // listeners off first so they see the starting → idle transition on the
    // new entry.
    const prior = this.evictEntry(key);
    if (prior) {
      await this.shutdownEntry(prior).catch(() => {});
    }

    try {
      let url = this.gatewayUrl;
      if (!url) {
        const result = await window.jupyterAPI.startGateway();
        if ('error' in result) {
          const message = (result as { error: string }).error;
          this.updatePending(key, { status: 'dead', error: message });
          return this.getPendingSnapshot(key);
        }
        url = result.url;
        this.gatewayUrl = url;
      }

      const serverSettings = ServerConnection.makeSettings({
        baseUrl: url,
        wsUrl: url.replace('http', 'ws'),
      });

      const manager = new KernelManager({ serverSettings });
      await manager.ready;

      const kernel = await manager.startNew({ name: kernelName });

      const entry: KernelEntry = {
        kernel,
        manager,
        kernelName,
        status: 'starting',
        error: null,
        listeners: new Set(),
      };

      // Migrate any pending listeners over to this entry.
      const pendingListeners = this.pendingListeners.get(key);
      if (pendingListeners) {
        for (const cb of pendingListeners) entry.listeners.add(cb);
        this.pendingListeners.delete(key);
      }
      this.pendingSnapshots.delete(key);

      kernel.statusChanged.connect((_, s) => {
        const next: KernelStatus =
          s === 'idle'
            ? 'idle'
            : s === 'busy'
              ? 'busy'
              : s === 'dead' || s === 'terminating' || s === 'autorestarting'
                ? 'dead'
                : s === 'starting' || s === 'restarting'
                  ? 'starting'
                  : entry.status;
        if (next === entry.status) return;
        entry.status = next;
        this.notify(entry);
        if (next === 'dead') {
          const evicted = this.evictEntry(key);
          if (evicted) this.shutdownEntry(evicted).catch(() => {});
        }
      });

      this.entries.set(key, entry);

      await kernel.info;
      entry.status = 'idle';
      this.notify(entry);
      return this.snapshot(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updatePending(key, { status: 'dead', error: message });
      return this.getPendingSnapshot(key);
    }
  }

  async execute(
    key: string,
    code: string,
    onOutput: (output: CellOutput) => void,
  ): Promise<number | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const future = entry.kernel.requestExecute({ code });

    return new Promise((resolve) => {
      future.onIOPub = (msg: IIOPubMessage) => {
        const msgType = msg.header.msg_type;
        const content = msg.content as Record<string, unknown>;
        if (msgType === 'stream') {
          onOutput({
            output_type: 'stream',
            name: content.name as 'stdout' | 'stderr',
            text: [content.text as string],
          });
        } else if (msgType === 'execute_result') {
          onOutput({
            output_type: 'execute_result',
            data: content.data as Record<string, unknown>,
            metadata: (content.metadata ?? {}) as Record<string, unknown>,
            execution_count: content.execution_count as number,
          });
        } else if (msgType === 'display_data') {
          onOutput({
            output_type: 'display_data',
            data: content.data as Record<string, unknown>,
            metadata: (content.metadata ?? {}) as Record<string, unknown>,
          });
        } else if (msgType === 'error') {
          onOutput({
            output_type: 'error',
            ename: content.ename as string,
            evalue: content.evalue as string,
            traceback: content.traceback as string[],
          });
        }
      };

      future.done
        .then((reply) => {
          const count = (reply.content as unknown as Record<string, unknown>).execution_count as
            | number
            | undefined;
          resolve(count ?? null);
        })
        .catch(() => {
          resolve(null);
        });
    });
  }

  async interrupt(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) await entry.kernel.interrupt();
  }

  async restart(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.status = 'starting';
    entry.error = null;
    this.notify(entry);
    try {
      await entry.kernel.restart();
      await entry.kernel.info;
      entry.status = 'idle';
      this.notify(entry);
    } catch (err) {
      entry.status = 'dead';
      entry.error = err instanceof Error ? err.message : String(err);
      this.notify(entry);
      const evicted = this.evictEntry(key);
      if (evicted) this.shutdownEntry(evicted).catch(() => {});
    }
  }

  async shutdown(key: string): Promise<void> {
    // Drain any in-flight start so we don't race past it and let it re-insert
    // a stale entry after we've cleared state.
    const starting = this.starting.get(key);
    if (starting) await starting.catch(() => {});

    const entry = this.entries.get(key);
    this.entries.delete(key);
    // Explicit shutdown drops listeners too — caller has closed the tab.
    this.pendingSnapshots.delete(key);
    this.pendingListeners.delete(key);
    if (!entry) return;
    await this.shutdownEntry(entry);
  }

  private async shutdownEntry(entry: KernelEntry): Promise<void> {
    entry.listeners.clear();
    try {
      await entry.kernel.shutdown();
    } catch {
      // Kernel may already be dead
    }
    try {
      if (!entry.kernel.isDisposed) {
        Signal.clearData(entry.kernel);
        entry.kernel.dispose();
      }
    } catch {
      // ignore
    }
    try {
      if (!entry.manager.isDisposed) entry.manager.dispose();
    } catch {
      // ignore
    }
  }

  async clearAll(): Promise<void> {
    const starts = Array.from(this.starting.values());
    if (starts.length > 0) {
      await Promise.allSettled(starts);
    }

    const entries = Array.from(this.entries.values());
    this.entries.clear();
    this.pendingSnapshots.clear();
    this.pendingListeners.clear();
    this.gatewayUrl = null;
    await Promise.all(entries.map((entry) => this.shutdownEntry(entry).catch(() => {})));
  }
}

export const kernelRegistry = new KernelRegistry();
