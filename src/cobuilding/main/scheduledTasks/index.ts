import log from 'electron-log';
import { createTaskScheduler, type TaskScheduler } from './scheduler';
import type { NotificationNavigationAction } from '../../shared/types';

let scheduler: TaskScheduler | null = null;

export function startScheduledTasks(
  onNotificationClick?: (action: NotificationNavigationAction | null) => void,
): void {
  if (scheduler) return;

  scheduler = createTaskScheduler(onNotificationClick);
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
