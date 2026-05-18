import { CronExpressionParser } from 'cron-parser';
import log from 'electron-log';
import { captureError } from '../../shared/telemetry';
import { getTask, getEnabledTasks, updateLastRun } from '../db/scheduledTaskRepository';
import { getActiveWorkspace } from '../db/workspaceRepository';
import { runScheduledTask } from './runner';
import type { NotificationNavigationAction } from '../../shared/types';

export interface TaskScheduler {
  start(): void;
  stop(): void;
  scheduleTask(taskId: string): void;
  unscheduleTask(taskId: string): void;
}

export function createTaskScheduler(
  onNotificationClick?: (action: NotificationNavigationAction | null) => void,
): TaskScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleNext(taskId: string): void {
    unschedule(taskId);

    const task = getTask(taskId);
    if (!task || !task.enabled) return;

    let nextDate: Date;
    try {
      const interval = CronExpressionParser.parse(task.cron_expression);
      nextDate = new Date(interval.next().toISOString()!);
    } catch (err) {
      log.error(`[ScheduledTasks] Invalid cron expression for task "${task.name}":`, err);
      return;
    }

    const delay = nextDate.getTime() - Date.now();
    if (delay < 0) return;

    updateLastRun(taskId, task.last_run_at ?? '', nextDate.toISOString());

    log.info(`[ScheduledTasks] Task "${task.name}" next run in ${Math.round(delay / 1000)}s at ${nextDate.toISOString()}`);

    const timer = setTimeout(async () => {
      timers.delete(taskId);

      const currentTask = getTask(taskId);
      if (!currentTask || !currentTask.enabled) return;

      const workspace = getActiveWorkspace();
      if (!workspace) {
        log.warn('[ScheduledTasks] No active workspace, skipping task:', currentTask.name);
        scheduleNext(taskId);
        return;
      }

      const now = new Date().toISOString();
      log.info(`[ScheduledTasks] Running task "${currentTask.name}"`);

      try {
        await runScheduledTask(currentTask, workspace, onNotificationClick);
        log.info(`[ScheduledTasks] Task "${currentTask.name}" completed`);
      } catch (err) {
        log.error(`[ScheduledTasks] Task "${currentTask.name}" failed:`, err);
        captureError(err, {
          subsystem: 'scheduled_task',
          extra: { task_id: currentTask.id, task_name: currentTask.name },
        });
      }

      // Compute and store next run time
      try {
        const interval = CronExpressionParser.parse(currentTask.cron_expression);
        const next = interval.next().toISOString()!;
        updateLastRun(taskId, now, next);
      } catch {
        // ignore parse errors here
      }

      scheduleNext(taskId);
    }, delay);

    timers.set(taskId, timer);
  }

  function unschedule(taskId: string): void {
    const existing = timers.get(taskId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(taskId);
    }
  }

  return {
    start() {
      const workspace = getActiveWorkspace();
      if (!workspace) {
        log.warn('[ScheduledTasks] No active workspace, scheduler not starting');
        return;
      }

      const tasks = getEnabledTasks(workspace.id);
      log.info(`[ScheduledTasks] Starting scheduler with ${tasks.length} enabled task(s)`);

      for (const task of tasks) {
        scheduleNext(task.id);
      }
    },

    stop() {
      for (const [taskId, timer] of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      log.info('[ScheduledTasks] Scheduler stopped');
    },

    scheduleTask(taskId: string) {
      scheduleNext(taskId);
    },

    unscheduleTask(taskId: string) {
      unschedule(taskId);
      log.info(`[ScheduledTasks] Unscheduled task ${taskId}`);
    },
  };
}
