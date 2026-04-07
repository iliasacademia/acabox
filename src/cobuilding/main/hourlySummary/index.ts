import log from 'electron-log';
import { createScheduler, type Scheduler } from './scheduler';
import { runSummaryAgent } from './noteTaker';
import { getActiveWorkspace } from '../db/workspaceRepository';

let scheduler: Scheduler | null = null;

export function startHourlySummary(): void {
  if (scheduler) return;

  scheduler = createScheduler(async () => {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      log.warn('[HourlySummary] No active workspace, skipping');
      return;
    }

    log.info('[HourlySummary] Starting summary agent');
    await runSummaryAgent(workspace);
    log.info('[HourlySummary] Summary agent complete');
  });

  scheduler.start();
  log.info('[HourlySummary] Service started');
}

export function isHourlySummaryRunning(): boolean {
  return scheduler !== null;
}

export function stopHourlySummary(): void {
  if (!scheduler) return;
  scheduler.stop();
  scheduler = null;
  log.info('[HourlySummary] Service stopped');
}
