import log from 'electron-log';
import { createTaskScheduler, type TaskScheduler } from './scheduler';

let scheduler: TaskScheduler | null = null;

export function startScheduledTasks(): void {
  if (scheduler) return;

  scheduler = createTaskScheduler();
  scheduler.start();
  log.info('[ScheduledTasks] Service started');
}

export function getTaskScheduler(): TaskScheduler {
  if (!scheduler) throw new Error('Scheduled tasks service not started');
  return scheduler;
}

export function stopScheduledTasks(): void {
  if (!scheduler) return;
  scheduler.stop();
  scheduler = null;
  log.info('[ScheduledTasks] Service stopped');
}
