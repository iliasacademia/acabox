/**
 * @jest-environment node
 */
jest.mock('electron-log', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../../shared/telemetry', () => ({ captureError: jest.fn() }));
jest.mock('../../db/scheduledTaskRepository', () => ({
  getTask: jest.fn(),
  getEnabledTasks: jest.fn(() => []),
  updateLastRun: jest.fn(),
  failInterruptedRuns: jest.fn(() => 0),
}));
jest.mock('../../db/workspaceRepository', () => ({ getActiveWorkspace: jest.fn(() => ({ id: 'ws' })) }));
jest.mock('../runner', () => ({ runScheduledTask: jest.fn(async () => undefined) }));

import { createTaskScheduler, MAX_TIMER_MS } from '../scheduler';
import { getTask, failInterruptedRuns } from '../../db/scheduledTaskRepository';
import { runScheduledTask } from '../runner';

const DAY = 86_400_000;

function task(cron: string) {
  return { id: 't1', name: 'T', enabled: 1, cron_expression: cron, last_run_at: null } as any;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-01T12:00:00'));
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

describe('scheduler timer clamp', () => {
  it('a target beyond the setTimeout ceiling arms a clamped timer and does not run early', () => {
    // 1 January: ~92 days out, far above 2^31-1 ms (~24.8 days).
    (getTask as jest.Mock).mockReturnValue(task('0 0 1 1 *'));
    const spy = jest.spyOn(global, 'setTimeout');
    const s = createTaskScheduler();
    s.scheduleTask('t1');

    const delay = spy.mock.calls[spy.mock.calls.length - 1][1] as number;
    expect(delay).toBe(MAX_TIMER_MS);

    // The clamped hop expires. The task must not run; a new timer is armed.
    jest.advanceTimersByTime(MAX_TIMER_MS);
    expect(runScheduledTask).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(30 * DAY);
    expect(runScheduledTask).not.toHaveBeenCalled();
    s.stop();
  });

  it('a near target runs the task once, at its time', async () => {
    (getTask as jest.Mock).mockReturnValue(task('*/5 * * * *'));
    const s = createTaskScheduler();
    s.scheduleTask('t1');
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(runScheduledTask).toHaveBeenCalledTimes(1);
    s.stop();
  });
});

describe('scheduler start', () => {
  it('repairs run rows a previous process left running', () => {
    createTaskScheduler().start();
    expect(failInterruptedRuns).toHaveBeenCalledTimes(1);
  });
});
