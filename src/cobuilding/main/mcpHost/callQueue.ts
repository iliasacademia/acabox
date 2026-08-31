import log from 'electron-log';

/**
 * Per-hosted-server bounded FIFO call queue (design: `docs/design/mcp-hosting.md`,
 * Increment 2). One instance per server, owned by `supervisor.ts` for the
 * lifetime of that server's handle.
 *
 * Why a queue at all: today's per-turn CLI subprocess gives every caller its
 * own child, so per-caller concurrency is already 1. Sharing ONE child across
 * every caller (the whole point of "hosted") means concurrent callers must be
 * serialized (or bounded) at the application layer instead, since the OS
 * process itself is now shared state. Default concurrency 1 is therefore not
 * a regression — it is the same effective concurrency today's design already
 * has, just enforced in a new place because the child is no longer disposable
 * per call.
 *
 * Three deliberate properties, each pinned by a test in `mcpHostQueue.test.ts`:
 *
 * 1. **Depth cap 32, enforced at `enqueue()` time, not inside the queue.** A
 *    32nd call sitting in a JS array costs nothing to accept and everything to
 *    regret — accepting it and then failing it later (e.g. via the per-call
 *    timeout) would burn 90s of the caller's patience to deliver a message
 *    that was knowable in a microtask. The 33rd call is rejected before it
 *    ever touches the FIFO, in well under a millisecond.
 * 2. **The 90s per-call deadline is measured from `enqueue()`, not from when
 *    the call starts running.** At concurrency 1 with a full queue, a call
 *    can legitimately wait a long time for its turn; the deadline has to
 *    cover that wait or a slow queue could silently exceed the caller's own
 *    budget while every individual queue entry claims to be "within 90s" of
 *    its own start. The timeout message says which phase it caught the call
 *    in — still queued, or already executing — because those imply different
 *    fixes (lower concurrency elsewhere vs. a genuinely hung tool).
 * 3. **`drain()` empties the WAITING portion of the queue immediately** with a
 *    caller-supplied reason, rather than leaving those entries to expire on
 *    their own 90s timers. This is what `supervisor.ts` calls the instant a
 *    server leaves `'ready'` (pause/stop/crash/failed) — a call queued behind
 *    a server that just died has no chance of ever running, and making its
 *    caller wait out a timeout to learn that would just be a slower way of
 *    saying the same "no" `drain()` says immediately. A call already
 *    EXECUTING (already handed to `run()`) is not touched by `drain()` — its
 *    own promise settles on its own, from whatever `run()` itself does when
 *    the server it's mid-call to disappears.
 */

export const CALL_QUEUE_DEPTH_CAP = 32;
export const CALL_QUEUE_DEFAULT_TIMEOUT_MS = 90_000;
export const CALL_QUEUE_MIN_CONCURRENCY = 1;
export const CALL_QUEUE_MAX_CONCURRENCY = 8;

export interface CallQueueOptions {
  /** Clamped to [1, 8] — see `CALL_QUEUE_MIN_CONCURRENCY`/`MAX_CONCURRENCY`. */
  concurrency?: number;
  /** Per-call deadline from enqueue to settle. Overridable only for tests — production callers should leave this at the default. */
  timeoutMs?: number;
  /** Overridable depth cap, for the same reason as `timeoutMs`. */
  depthCap?: number;
}

interface Entry<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** Flipped once this entry has been handed to `run()`, so the timeout
   *  handler and `drain()` both know whether it was still waiting or already
   *  executing — the distinction the timeout message and `drain()`'s "only
   *  touch the waiting portion" contract both depend on. */
  running: boolean;
  /** Guards against the timeout firing after the call has already settled
   *  normally (or vice versa) — `clearTimeout` alone is not enough because
   *  the timer and the `run()` promise resolve independently and either can
   *  win the race. */
  settled: boolean;
}

function clampConcurrency(n: number | undefined): number {
  if (n === undefined) return CALL_QUEUE_MIN_CONCURRENCY;
  if (!Number.isFinite(n)) return CALL_QUEUE_MIN_CONCURRENCY;
  return Math.max(CALL_QUEUE_MIN_CONCURRENCY, Math.min(CALL_QUEUE_MAX_CONCURRENCY, Math.floor(n)));
}

/**
 * A bounded FIFO semaphore for one hosted server's calls. Generic over the
 * call's own result type so `supervisor.ts` can enqueue a real
 * `client.callTool(...)` promise without this module needing to know
 * anything about MCP.
 */
export class ServerCallQueue {
  private concurrency: number;
  private readonly timeoutMs: number;
  private readonly depthCap: number;
  private readonly waiting: Entry<unknown>[] = [];
  private runningCount = 0;

  constructor(
    private readonly serverId: string,
    opts: CallQueueOptions = {},
  ) {
    this.concurrency = clampConcurrency(opts.concurrency);
    this.timeoutMs = opts.timeoutMs ?? CALL_QUEUE_DEFAULT_TIMEOUT_MS;
    this.depthCap = opts.depthCap ?? CALL_QUEUE_DEPTH_CAP;
  }

  setConcurrency(n: number): void {
    this.concurrency = clampConcurrency(n);
    this.pump();
  }

  /** Queued-and-not-yet-run, plus currently executing. What the depth cap bounds. */
  get depth(): number {
    return this.waiting.length + this.runningCount;
  }

  /**
   * Submit one call. Rejects synchronously-fast (no queueing at all) once
   * `depth >= depthCap` — see property 1 in the module comment.
   */
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.depth >= this.depthCap) {
      return Promise.reject(
        new Error(`Server "${this.serverId}" is too busy: ${this.depth} calls are already queued or running (limit ${this.depthCap}). Try again shortly.`),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const entry: Entry<T> = {
        run,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        running: false,
        settled: false,
        // Placeholder — replaced immediately below once `entry` exists, since
        // the timeout handler needs to close over the entry it belongs to.
        timer: setTimeout(() => {}, 0),
      };
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onTimeout(entry as Entry<unknown>), this.timeoutMs);
      entry.timer.unref?.();
      this.waiting.push(entry as Entry<unknown>);
      this.pump();
    });
  }

  private onTimeout(entry: Entry<unknown>): void {
    if (entry.settled) return;
    entry.settled = true;
    const waitedMs = Date.now() - entry.enqueuedAt;
    const idx = this.waiting.indexOf(entry);
    const phase = entry.running ? 'executing' : 'queued, waiting for a turn';
    if (idx !== -1) this.waiting.splice(idx, 1);
    // An executing entry still occupies a concurrency slot in `runningCount`
    // until its own `run()` promise eventually settles (see the handler in
    // `pump()`) — we stop waiting on it here, but do not force it to release
    // the slot early, since we have no way to cancel an arbitrary in-flight
    // async call. A server that hangs like this is exactly what the
    // supervisor's ping health-check exists to detect and restart.
    entry.reject(new Error(
      `Call to server "${this.serverId}" timed out after ${Math.round(this.timeoutMs / 1000)}s (${phase} for ${Math.round(waitedMs / 1000)}s).`,
    ));
  }

  private pump(): void {
    while (this.runningCount < this.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      if (entry.settled) continue; // already timed out between push and this tick
      entry.running = true;
      this.runningCount++;
      entry.run().then(
        (value) => {
          this.runningCount--;
          if (!entry.settled) { entry.settled = true; clearTimeout(entry.timer); entry.resolve(value); }
          this.pump();
        },
        (err: unknown) => {
          this.runningCount--;
          if (!entry.settled) { entry.settled = true; clearTimeout(entry.timer); entry.reject(err instanceof Error ? err : new Error(String(err))); }
          this.pump();
        },
      );
    }
  }

  /**
   * Reject every entry still WAITING (not yet handed to `run()`) immediately,
   * with `reason` as the message. Entries already executing are left alone —
   * see property 3 in the module comment for why.
   */
  drain(reason: string): void {
    const toReject = this.waiting.splice(0, this.waiting.length);
    for (const entry of toReject) {
      if (entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    if (toReject.length > 0) {
      log.info(`[McpHostQueue] Drained ${toReject.length} waiting call(s) for "${this.serverId}": ${reason}`);
    }
  }
}
