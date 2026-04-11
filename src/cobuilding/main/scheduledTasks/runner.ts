import log from 'electron-log';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createAgentSession } from '../agentSession';
import { updateSessionTitle } from '../db/chatRepository';
import { createTaskRun, completeTaskRun } from '../db/scheduledTaskRepository';
import { registerSession, unregisterSession } from '../sessionRegistry';
import { getLocalDate, getLocalTime, getLocalTimezone } from '../../shared/utils';
import type { ScheduledTask } from '../db/scheduledTaskRepository';
import type { Workspace, NotificationNavigationAction } from '../../shared/types';

function getFocusContent(workspace: Workspace): string | null {
  try {
    const focusPath = path.join(workspace.directory_path, '.academia', 'FOCUS.md');
    const content = fs.readFileSync(focusPath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

export function runScheduledTask(
  task: ScheduledTask,
  workspace: Workspace,
  onNotificationClick?: (action: NotificationNavigationAction | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const timeLabel = getLocalTime(now);
    const tz = getLocalTimezone();

    const sessionId = randomUUID();
    const runId = createTaskRun(task.id, sessionId);

    const session = createAgentSession(
      sessionId,
      {
        onEvent: () => {},
        onDone: () => {
          updateSessionTitle(sessionId, `[Task] ${task.name} — ${getLocalDate(now)}${tz ? ` (${tz})` : ''} ${timeLabel}`);
          completeTaskRun(runId, 'completed');
          log.info(`[ScheduledTasks] Task run completed: ${task.name} (session: ${sessionId})`);
          unregisterSession(sessionId);
          resolve();
        },
        onError: (error) => {
          completeTaskRun(runId, 'failed', error);
          log.error(`[ScheduledTasks] Task run failed: ${task.name}: ${error}`);
          unregisterSession(sessionId);
          reject(new Error(error));
        },
      },
      workspace,
      undefined,
      task.session_source ?? undefined,
      onNotificationClick,
    );

    registerSession(sessionId, session);

    let prompt = task.prompt;
    if (task.session_source === 'reactions-system') {
      const focusContent = getFocusContent(workspace);
      if (focusContent) {
        prompt += '\n\nUser\'s research focus (from FOCUS.md):\n' + focusContent;
      }
    }
    session.sendMessage(prompt);
  });
}
