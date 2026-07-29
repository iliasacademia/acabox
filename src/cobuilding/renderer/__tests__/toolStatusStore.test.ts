/**
 * Tool runtime status: the merge of build/install lifecycle with in-flight
 * activity, and the delay-in / hold-out timing that keeps the WORKING chip
 * from strobing on sub-second operations.
 *
 * These exercise the real store module — no reimplementation of the timing
 * rules here, or the test would pass while the app still lied.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useToolStatus,
  applyHostJobs,
  WORKING_SHOW_DELAY_MS,
  WORKING_MIN_VISIBLE_MS,
  setToolLifecycle,
  clearToolStatus,
  beginToolActivity,
  trackToolActivity,
  onToolRunEnded,
  getToolStatusSnapshot,
  __resetToolStatusStore,
} from '../toolStatusStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DIR = 'dataCoverageMap';

/** Current status of a tool as the UI reads it — a miss means idle. */
function kindOf(dirName: string): string {
  return getToolStatusSnapshot().get(dirName)?.kind ?? 'idle';
}

function readSnapshot() {
  return getToolStatusSnapshot();
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetToolStatusStore();
});

afterEach(() => {
  __resetToolStatusStore();
  jest.useRealTimers();
});

describe('resting state', () => {
  it('is idle, and idle tools are absent from the snapshot', () => {
    expect(kindOf(DIR)).toBe('idle');
    expect(readSnapshot().has(DIR)).toBe(false);
  });

  it('stays absent when lifecycle is explicitly set to idle', () => {
    setToolLifecycle(DIR, { kind: 'building' });
    expect(kindOf(DIR)).toBe('building');
    setToolLifecycle(DIR, { kind: 'idle' });
    expect(readSnapshot().has(DIR)).toBe(false);
  });
});

describe('delay-in', () => {
  it('never shows WORKING for an operation shorter than the delay', () => {
    const end = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS - 1);
    expect(kindOf(DIR)).toBe('idle');
    end();
    jest.advanceTimersByTime(10_000);
    expect(kindOf(DIR)).toBe('idle');
  });

  it('shows WORKING once the operation outlives the delay', () => {
    beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS - 1);
    expect(kindOf(DIR)).toBe('idle');
    jest.advanceTimersByTime(1);
    expect(kindOf(DIR)).toBe('working');
  });
});

describe('hold-out', () => {
  it('holds WORKING for the minimum visible time after a brief-but-shown op', () => {
    const end = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + 200); // visible for 200ms
    expect(kindOf(DIR)).toBe('working');
    end();
    expect(kindOf(DIR)).toBe('working'); // still held

    jest.advanceTimersByTime(WORKING_MIN_VISIBLE_MS - 200 - 1);
    expect(kindOf(DIR)).toBe('working');
    jest.advanceTimersByTime(1);
    expect(kindOf(DIR)).toBe('idle');
  });

  it('clears immediately when the op already ran past the minimum', () => {
    const end = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS + 5_000);
    expect(kindOf(DIR)).toBe('working');
    end();
    expect(kindOf(DIR)).toBe('idle');
  });

  it('does not blink when a new op starts inside the hold-out window', () => {
    const first = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);
    first();
    // Ended past the minimum, so it cleared. Re-open and confirm the next op
    // re-shows only after its own delay (no stale visible flag).
    expect(kindOf(DIR)).toBe('idle');

    const second = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS);
    expect(kindOf(DIR)).toBe('working');

    second();
    // Held; a third op inside the hold-out must keep it continuously WORKING.
    const third = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_MIN_VISIBLE_MS * 2);
    expect(kindOf(DIR)).toBe('working');
    third();
    expect(kindOf(DIR)).toBe('idle');
  });
});

describe('ref counting', () => {
  it('stays WORKING until the last overlapping op ends', () => {
    const a = beginToolActivity(DIR);
    const b = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);
    expect(kindOf(DIR)).toBe('working');

    a();
    expect(kindOf(DIR)).toBe('working');
    b();
    expect(kindOf(DIR)).toBe('idle');
  });

  it('ignores a repeated end() from the same operation', () => {
    const a = beginToolActivity(DIR);
    const b = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);

    a();
    a();
    a();
    expect(kindOf(DIR)).toBe('working'); // b is still in flight
    b();
    expect(kindOf(DIR)).toBe('idle');
  });

  it('keeps tools independent', () => {
    const a = beginToolActivity('toolA');
    beginToolActivity('toolB');
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);
    a();
    expect(kindOf('toolA')).toBe('idle');
    expect(kindOf('toolB')).toBe('working');
  });
});

describe('precedence', () => {
  it('reports buildFailed over working', () => {
    beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS);
    expect(kindOf(DIR)).toBe('working');

    setToolLifecycle(DIR, { kind: 'buildFailed', message: 'boom', at: 1 });
    expect(kindOf(DIR)).toBe('buildFailed');
  });

  it('reports building and installing over working', () => {
    beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS);

    setToolLifecycle(DIR, { kind: 'building' });
    expect(kindOf(DIR)).toBe('building');

    setToolLifecycle(DIR, { kind: 'installing', done: 1, total: 3 });
    expect(kindOf(DIR)).toBe('installing');

    // Falling back to idle re-reveals the still-in-flight activity.
    setToolLifecycle(DIR, { kind: 'idle' });
    expect(kindOf(DIR)).toBe('working');
  });
});

describe('run-ended notifications', () => {
  it('fires once per episode, not per operation', () => {
    const seen: string[] = [];
    const off = onToolRunEnded((d) => seen.push(d));

    const a = beginToolActivity(DIR);
    const b = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);
    a();
    expect(seen).toEqual([]);
    b();
    expect(seen).toEqual([DIR]);

    off();
  });

  it('fires for an operation too short to have been shown', () => {
    const seen: string[] = [];
    const off = onToolRunEnded((d) => seen.push(d));

    const end = beginToolActivity(DIR);
    jest.advanceTimersByTime(10);
    end();

    expect(seen).toEqual([DIR]);
    expect(kindOf(DIR)).toBe('idle');
    off();
  });
});

describe('viewer unmount', () => {
  it('drops in-flight activity and survives a late end()', () => {
    const end = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS);
    expect(kindOf(DIR)).toBe('working');

    clearToolStatus(DIR);
    expect(kindOf(DIR)).toBe('idle');

    // The op's promise settles after the viewer is gone — must not resurrect.
    end();
    jest.advanceTimersByTime(10_000);
    expect(kindOf(DIR)).toBe('idle');
  });

  it('does not let a stale end() decrement a fresh episode', () => {
    const stale = beginToolActivity(DIR);
    clearToolStatus(DIR);

    const fresh = beginToolActivity(DIR);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);
    expect(kindOf(DIR)).toBe('working');

    stale();
    expect(kindOf(DIR)).toBe('working'); // the fresh op is still in flight
    fresh();
    expect(kindOf(DIR)).toBe('idle');
  });
});

describe('host jobs (status that outlives the tool viewer)', () => {
  const job = (over: Partial<{ id: string; dirName: string; status: string }> = {}) =>
    ({ id: 'j1', dirName: DIR, status: 'running', ...over });

  it('shows WORKING for a running host job, with the usual delay-in', () => {
    applyHostJobs([job()]);
    expect(kindOf(DIR)).toBe('idle');
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS);
    expect(kindOf(DIR)).toBe('working');
  });

  it('clears WORKING when the job leaves the running set', () => {
    applyHostJobs([job()]);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);
    expect(kindOf(DIR)).toBe('working');

    applyHostJobs([job({ status: 'done' })]);
    expect(kindOf(DIR)).toBe('idle');
  });

  it('holds WORKING while any one of several jobs is still running', () => {
    applyHostJobs([job({ id: 'a' }), job({ id: 'b' })]);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);
    applyHostJobs([job({ id: 'a', status: 'done' }), job({ id: 'b' })]);
    expect(kindOf(DIR)).toBe('working');
    applyHostJobs([job({ id: 'a', status: 'done' }), job({ id: 'b', status: 'done' })]);
    expect(kindOf(DIR)).toBe('idle');
  });

  it('is idempotent — repeating the same list does not stack activity', () => {
    applyHostJobs([job()]);
    applyHostJobs([job()]);
    applyHostJobs([job()]);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS + WORKING_MIN_VISIBLE_MS);
    expect(kindOf(DIR)).toBe('working');
    applyHostJobs([]);
    expect(kindOf(DIR)).toBe('idle');
  });

  it('reports work that outlived a restart as RAN WHILE CLOSED', () => {
    applyHostJobs([job({ status: 'finishedWhileAway' })]);
    const s = readSnapshot().get(DIR);
    expect(s).toEqual({ kind: 'interrupted', reason: 'finishedWhileAway' });
  });

  it('reports work that died with the app as interrupted', () => {
    applyHostJobs([job({ status: 'interrupted' })]);
    expect(readSnapshot().get(DIR)).toEqual({ kind: 'interrupted', reason: 'interrupted' });
  });

  it('prefers the more informative reason when a tool has both', () => {
    applyHostJobs([
      job({ id: 'a', status: 'interrupted' }),
      job({ id: 'b', status: 'finishedWhileAway' }),
    ]);
    expect(readSnapshot().get(DIR)).toEqual({ kind: 'interrupted', reason: 'finishedWhileAway' });
  });

  it('ranks live work above a past interruption', () => {
    applyHostJobs([job({ id: 'old', status: 'interrupted' }), job({ id: 'new' })]);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS);
    expect(kindOf(DIR)).toBe('working');
  });

  it('ranks a build failure above live work', () => {
    applyHostJobs([job()]);
    jest.advanceTimersByTime(WORKING_SHOW_DELAY_MS);
    setToolLifecycle(DIR, { kind: 'buildFailed', message: 'x', at: 1 });
    expect(kindOf(DIR)).toBe('buildFailed');
  });

  it('clears the notice once the job is acknowledged and drops off the list', () => {
    applyHostJobs([job({ status: 'finishedWhileAway' })]);
    expect(kindOf(DIR)).toBe('interrupted');
    applyHostJobs([]); // main removed it after acknowledge()
    expect(kindOf(DIR)).toBe('idle');
  });
});

describe('useToolStatus (the path the UI actually renders through)', () => {
  it('re-renders a subscriber as the tool moves idle → working → idle', async () => {
    jest.useRealTimers();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Probe() {
      const status = useToolStatus(DIR);
      return React.createElement('span', null, status.kind);
    }

    await act(async () => { root.render(React.createElement(Probe)); });
    expect(container.textContent).toBe('idle');

    let end: () => void = () => {};
    // The delay-in timer fires inside this act(), so the resulting store
    // notification and re-render are both flushed before we assert.
    await act(async () => {
      end = beginToolActivity(DIR);
      await sleep(WORKING_SHOW_DELAY_MS + 50);
    });
    expect(container.textContent).toBe('working');

    await act(async () => {
      end();
      await sleep(WORKING_MIN_VISIBLE_MS + 100);
    });
    expect(container.textContent).toBe('idle');

    await act(async () => { root.unmount(); });
    container.remove();
  }, 10_000);
});

describe('trackToolActivity', () => {
  it('ends the episode when the promise resolves', async () => {
    jest.useRealTimers();
    const p = trackToolActivity(DIR, () => new Promise((r) => setTimeout(() => r('ok'), 250)));
    await new Promise((r) => setTimeout(r, 220));
    expect(kindOf(DIR)).toBe('working');
    await expect(p).resolves.toBe('ok');
    await new Promise((r) => setTimeout(r, WORKING_MIN_VISIBLE_MS + 50));
    expect(kindOf(DIR)).toBe('idle');
  });

  it('ends the episode when the promise rejects', async () => {
    const p = trackToolActivity(DIR, () => Promise.reject(new Error('nope')));
    await expect(p).rejects.toThrow('nope');
    expect(kindOf(DIR)).toBe('idle');
  });
});
