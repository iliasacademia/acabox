/**
 * The "On a schedule" section shipped with a 30s poll because nothing
 * announced a scheduled-task write. The poll's real target was the case no IPC
 * covers: a run started by the scheduler's OWN clock, which stamps
 * `last_run_at`/`next_run_at` and writes run rows with no user gesture
 * anywhere. Every tab in this shell stays mounted forever, so a fetch-on-mount
 * is correct once and stale after.
 *
 * The notification lives in the REPOSITORY, not the IPC handlers, because
 * `runner.ts` and `scheduler.ts` write directly. These tests exercise the real
 * repository against a real `scheduling.db` in a temp dir — house doctrine, and
 * `initSchedulingDatabase` takes a path, so no `electron` mock is needed at all.
 *
 * The point of asserting per-mutation rather than "it fires sometimes": a
 * future writer that adds a mutation and forgets to notify reintroduces exactly
 * the staleness the poll was hiding.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initSchedulingDatabase, closeSchedulingDatabase } from '../db/schedulingDatabase';
import {
  onScheduledTasksChanged,
  createTask, updateTask, deleteTask, setTaskEnabled, updateLastRun,
  createTaskRun, completeTaskRun, listTasks,
} from '../db/scheduledTaskRepository';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-schedbroadcast-'));
const WS = 'ws-1';

beforeAll(() => { initSchedulingDatabase(tmpDir); });
afterAll(() => {
  closeSchedulingDatabase();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Count notifications fired while `fn` runs, then unsubscribe. */
function countedDuring(fn: () => void): number {
  let n = 0;
  const off = onScheduledTasksChanged(() => { n++; });
  try { fn(); } finally { off(); }
  return n;
}

const newTask = () =>
  createTask(WS, 'Nightly', 'desc', 'do the thing', '0 */24 * * *', null);

describe('every scheduled-task mutation announces itself', () => {
  it('createTask', () => {
    expect(countedDuring(() => { newTask(); })).toBeGreaterThanOrEqual(1);
  });

  it('updateTask', () => {
    const t = newTask();
    expect(countedDuring(() => { updateTask(t.id, { name: 'Renamed' }); })).toBeGreaterThanOrEqual(1);
  });

  it('setTaskEnabled', () => {
    const t = newTask();
    expect(countedDuring(() => { setTaskEnabled(t.id, false); })).toBeGreaterThanOrEqual(1);
  });

  it('deleteTask', () => {
    const t = newTask();
    expect(countedDuring(() => { deleteTask(t.id); })).toBeGreaterThanOrEqual(1);
  });

  it('updateLastRun — the one the poll actually existed for', () => {
    // No IPC handler calls this; only the scheduler's timer does. If this stops
    // firing, the section silently goes stale again and only a tab switch fixes it.
    const t = newTask();
    const fired = countedDuring(() => {
      updateLastRun(t.id, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
    });
    expect(fired).toBeGreaterThanOrEqual(1);
  });

  it('createTaskRun and completeTaskRun — also scheduler-driven', () => {
    const t = newTask();
    let runId = '';
    expect(countedDuring(() => { runId = createTaskRun(t.id, 'session-1'); })).toBeGreaterThanOrEqual(1);
    expect(countedDuring(() => { completeTaskRun(runId, 'completed'); })).toBeGreaterThanOrEqual(1);
  });
});

describe('subscription hygiene', () => {
  it('a read fires nothing — no repaint storm from listing', () => {
    newTask();
    expect(countedDuring(() => { listTasks(WS); })).toBe(0);
  });

  it('unsubscribing really stops delivery', () => {
    let n = 0;
    onScheduledTasksChanged(() => { n++; })();   // subscribe, release immediately
    newTask();
    expect(n).toBe(0);
  });

  it('a throwing listener cannot break the write or starve the others', () => {
    let good = 0;
    const offBad = onScheduledTasksChanged(() => { throw new Error('listener blew up'); });
    const offGood = onScheduledTasksChanged(() => { good++; });
    try {
      expect(() => newTask()).not.toThrow();
      expect(good).toBeGreaterThanOrEqual(1);
    } finally { offBad(); offGood(); }
  });

  it('delivers to every subscriber, not just the first', () => {
    let a = 0, b = 0;
    const offA = onScheduledTasksChanged(() => { a++; });
    const offB = onScheduledTasksChanged(() => { b++; });
    try { newTask(); } finally { offA(); offB(); }
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).toBe(a);
  });
});
