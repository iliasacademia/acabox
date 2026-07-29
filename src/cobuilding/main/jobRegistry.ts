import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { app } from 'electron';
import log from 'electron-log';

/**
 * Host-owned record of work a tool is doing.
 *
 * Before this existed, "is this tool working?" was answered entirely inside the
 * tool's own viewer component. Navigating away unmounted that component and the
 * answer vanished — while the work carried on, because the work was never the
 * component's to begin with. Verified 2026-07-28: a shell command started by a
 * mini-app completes normally even after Acabox has fully quit (no Electron
 * process left), because `exec` children are not in the teardown path and a
 * POSIX child outlives its parent.
 *
 * So the job lives here, in main, where the work actually lives. The registry
 * survives navigation, survives the viewer being destroyed, and — because it is
 * persisted — survives the app restarting.
 *
 * What survives what, established by test rather than assumption:
 *   - `command` (shell) — outlives app quit. On boot we check whether the pid
 *     is still alive and still running our command, and re-adopt it if so.
 *   - `kernel` — dies with the app: `containerService.stop()` kills the Jupyter
 *     gateway in `before-quit`. Reported as interrupted, never as running.
 *   - `claude` — an HTTP request from main; dies with the app. Interrupted.
 */

export type JobKind = 'command' | 'kernel' | 'claude' | 'agent-tool';

export type JobStatus =
  | 'running'
  /** Ended normally while we were watching. */
  | 'done'
  /** Ended with an error while we were watching. */
  | 'failed'
  /** The app went away mid-flight and the work could not have continued. */
  | 'interrupted'
  /** Outlived the app; by the time we came back it was no longer running, and
   *  its outcome is genuinely unknown — do not claim it succeeded. */
  | 'finishedWhileAway'
  /** The user stopped it. Distinct from `failed` because any output it left
   *  behind is half-written and must not be adopted as a result. */
  | 'cancelled';

export interface ToolJob {
  id: string;
  /** `.applications/<dirName>` — which tool this work belongs to. */
  dirName: string;
  kind: JobKind;
  /** Short human-readable description, e.g. `sleep 3` or `Python cell`. */
  label: string;
  startedAt: number;
  endedAt?: number;
  status: JobStatus;
  /** Set for `command` jobs — the OS pid, used to re-adopt across a restart. */
  pid?: number;
  /** Signature used to guard against pid reuse when re-adopting. */
  pidSignature?: string;
  /** True once this job has been carried across an app restart. */
  adopted?: boolean;
  /** WebContents that reported this job, so its death can close the job. */
  ownerWebContentsId?: number;
}

/** Finished jobs older than this are dropped from the store. */
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;
const MAX_JOBS = 300;

let jobs: ToolJob[] = [];
let loaded = false;
const listeners = new Set<(jobs: ToolJob[]) => void>();
/** Called when a job completes, so the tool's manifest can record a run. */
let onRunCompleted: ((dirName: string) => void) | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), 'tool-jobs.json');
}

function persist(): void {
  try {
    // Only durable fields — a WebContents id is meaningless after a restart.
    const serializable = jobs.map(({ ownerWebContentsId, ...rest }) => rest);
    fs.writeFileSync(storePath(), JSON.stringify(serializable, null, 2), 'utf-8');
  } catch (err) {
    log.warn(`[Jobs] Could not persist job store: ${(err as Error).message}`);
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) jobs = parsed.filter((j) => j && typeof j.id === 'string');
  } catch {
    jobs = []; // missing or corrupt — start clean
  }
}

function prune(): void {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  jobs = jobs.filter((j) => j.status === 'running' || (j.endedAt ?? 0) >= cutoff);
  if (jobs.length > MAX_JOBS) {
    const running = jobs.filter((j) => j.status === 'running');
    const finished = jobs.filter((j) => j.status !== 'running')
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, Math.max(0, MAX_JOBS - running.length));
    jobs = [...running, ...finished];
  }
}

function emit(): void {
  prune();
  persist();
  const snapshot = listJobs();
  for (const l of listeners) {
    try { l(snapshot); } catch (err) { log.warn(`[Jobs] listener threw: ${(err as Error).message}`); }
  }
}

/**
 * A fingerprint of a running process, so a recycled pid can't be mistaken for
 * our job after a restart. Deliberately **start time only**: pid + start time
 * is unique, whereas the command line is not stable. `sh -c "…"` execs into the
 * program it runs, so `ps` reports `/bin/sh -c sleep 30` at spawn and `sleep 30`
 * a moment later — including the command here made every shell command fail to
 * re-adopt. Caught by test, 2026-07-28.
 */
function pidSignatureOf(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8', timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    return null; // no such process
  }
}

/**
 * Every descendant of `pid`, deepest first, so a tree can be killed from the
 * leaves up without orphaning anything.
 *
 * Deliberately NOT `kill(-pid)`: a process-group kill is the usual shortcut,
 * but these children are spawned without `detached`, so they share Acabox's own
 * process group — a negative-pid signal would kill the app itself. Adopted jobs
 * from an older build make that worse, since we can't know how they were
 * spawned. Walking the tree is safe regardless.
 */
function descendantsOf(pid: number, depth = 0): number[] {
  if (depth > 10) return [];
  let children: number[] = [];
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf-8', timeout: 5000 });
    children = out.trim().split('\n').filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return []; // no children (pgrep exits non-zero when it matches nothing)
  }
  const deeper = children.flatMap((c) => descendantsOf(c, depth + 1));
  return [...deeper, ...children];
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/**
 * Stop a job's work for real.
 *
 * `command` work is a real OS process tree and is killed outright. `kernel` and
 * `claude` work is driven by a renderer, which is the only thing that can
 * interrupt it, so the request is handed back to the owner — see
 * `setCancelRequestHandler`.
 */
export function cancelJob(id: string): { ok: boolean; reason?: string } {
  load();
  const job = jobs.find((j) => j.id === id);
  if (!job) return { ok: false, reason: 'no such job' };
  if (job.status !== 'running') return { ok: false, reason: 'not running' };

  if (job.kind === 'command' && job.pid) {
    const tree = [...descendantsOf(job.pid), job.pid];
    for (const p of tree) signal(p, 'SIGTERM');
    // Anything ignoring SIGTERM gets a hard stop shortly after.
    setTimeout(() => {
      for (const p of tree) {
        if (pidSignatureOf(p)) signal(p, 'SIGKILL');
      }
    }, 3000).unref?.();
    job.status = 'cancelled';
    job.endedAt = Date.now();
    emit();
    log.info(`[Jobs] Cancelled ${job.dirName} (${job.label}) — signalled ${tree.length} process(es)`);
    return { ok: true };
  }

  // Renderer-owned work: ask the owner to interrupt, and mark it now so the UI
  // responds immediately. If the owner is gone there is nothing left to stop.
  const handled = onCancelRequest?.(job) ?? false;
  job.status = 'cancelled';
  job.endedAt = Date.now();
  emit();
  log.info(`[Jobs] Cancelled ${job.dirName} (${job.kind}) — owner ${handled ? 'notified' : 'unavailable'}`);
  return { ok: true };
}

/** Cancel everything still running. Used by the quit dialog's "Stop them". */
export function cancelAll(): number {
  const running = activeJobs();
  for (const job of running) cancelJob(job.id);
  return running.length;
}

let onCancelRequest: ((job: ToolJob) => boolean) | null = null;

/**
 * Register how a renderer-owned job gets interrupted. Returns true if the
 * request reached an owner.
 */
export function setCancelRequestHandler(fn: (job: ToolJob) => boolean): void {
  onCancelRequest = fn;
}

export function subscribe(listener: (jobs: ToolJob[]) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Register the hook that stamps `manifest.lastRun` when work completes. */
export function setRunCompletedHandler(fn: (dirName: string) => void): void {
  onRunCompleted = fn;
}

export function beginJob(input: {
  dirName: string;
  kind: JobKind;
  label: string;
  pid?: number;
  ownerWebContentsId?: number;
}): ToolJob {
  load();
  const job: ToolJob = {
    id: randomUUID(),
    dirName: input.dirName,
    kind: input.kind,
    label: input.label.slice(0, 200),
    startedAt: Date.now(),
    status: 'running',
    pid: input.pid,
    pidSignature: input.pid ? pidSignatureOf(input.pid) ?? undefined : undefined,
    ownerWebContentsId: input.ownerWebContentsId,
  };
  jobs.push(job);
  emit();
  return job;
}

export function endJob(id: string, status: Exclude<JobStatus, 'running'> = 'done'): void {
  load();
  const job = jobs.find((j) => j.id === id);
  if (!job || job.status !== 'running') return;
  job.status = status;
  job.endedAt = Date.now();
  emit();
  if (status === 'done') onRunCompleted?.(job.dirName);
}

/** Close every still-running job reported by a renderer that has gone away. */
export function interruptJobsForWebContents(webContentsId: number): void {
  load();
  let changed = false;
  for (const job of jobs) {
    if (job.status === 'running' && job.ownerWebContentsId === webContentsId) {
      job.status = 'interrupted';
      job.endedAt = Date.now();
      changed = true;
    }
  }
  if (changed) emit();
}

export function listJobs(): ToolJob[] {
  load();
  return jobs.map((j) => ({ ...j }));
}

export function activeJobs(): ToolJob[] {
  return listJobs().filter((j) => j.status === 'running');
}

/** Clear the "interrupted"/"finished while away" notice for a tool. */
export function acknowledgeTool(dirName: string): void {
  load();
  const before = jobs.length;
  jobs = jobs.filter((j) => !(j.dirName === dirName && (j.status === 'interrupted' || j.status === 'finishedWhileAway')));
  if (jobs.length !== before) emit();
}

/**
 * Decide what happened to jobs left `running` by a previous app session.
 *
 * A shell command may genuinely still be running — it outlives us — so its pid
 * is checked (guarded by the start-time signature, so a recycled pid is not
 * adopted). Everything else died with the app and is reported as interrupted;
 * claiming otherwise would put a spinner next to work that stopped hours ago.
 */
export function reconcileOnBoot(): { adopted: number; interrupted: number; finishedWhileAway: number } {
  load();
  const counts = { adopted: 0, interrupted: 0, finishedWhileAway: 0 };
  for (const job of jobs) {
    if (job.status !== 'running') continue;

    if (job.kind !== 'command' || !job.pid) {
      job.status = 'interrupted';
      job.endedAt = Date.now();
      counts.interrupted++;
      continue;
    }

    const sig = pidSignatureOf(job.pid);
    if (sig && job.pidSignature && sig === job.pidSignature) {
      job.adopted = true;
      counts.adopted++;
    } else {
      // The process is gone (or the pid was recycled). It ran unsupervised, so
      // whether it succeeded is unknowable — say that rather than guess.
      job.status = 'finishedWhileAway';
      job.endedAt = Date.now();
      counts.finishedWhileAway++;
    }
  }
  if (counts.adopted + counts.interrupted + counts.finishedWhileAway > 0) {
    log.info(`[Jobs] Boot reconcile: ${counts.adopted} still running, ${counts.finishedWhileAway} finished while away, ${counts.interrupted} interrupted`);
    emit();
  }
  if (counts.adopted > 0) startAdoptedJobPolling();
  return counts;
}

/**
 * Adopted jobs have no parent to notify us when they exit, so poll their pids
 * until each one is gone. Stops by itself once none are left.
 */
let adoptedPoll: ReturnType<typeof setInterval> | null = null;
function startAdoptedJobPolling(): void {
  if (adoptedPoll) return;
  adoptedPoll = setInterval(() => {
    const adopted = jobs.filter((j) => j.status === 'running' && j.adopted && j.pid);
    if (adopted.length === 0) {
      clearInterval(adoptedPoll!);
      adoptedPoll = null;
      return;
    }
    let changed = false;
    for (const job of adopted) {
      const sig = pidSignatureOf(job.pid!);
      if (!sig || (job.pidSignature && sig !== job.pidSignature)) {
        job.status = 'finishedWhileAway';
        job.endedAt = Date.now();
        changed = true;
      }
    }
    if (changed) emit();
  }, 3000);
  adoptedPoll.unref?.();
}

/** Test seam. */
export function __resetJobRegistry(): void {
  jobs = [];
  loaded = true;
  listeners.clear();
  onRunCompleted = null;
  onCancelRequest = null;
  if (adoptedPoll) { clearInterval(adoptedPoll); adoptedPoll = null; }
}
