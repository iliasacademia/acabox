import log from 'electron-log';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createAgentSession } from '../agentSession';
import { updateSessionTitle } from '../db/chatRepository';
import { getLocalDate, getLocalTime, getLocalTimezone } from '../../shared/utils';
import type { Workspace } from '../../shared/types';

const SUMMARIES_DIR = path.join('.academia', 'summaries');

export function runSummaryAgent(workspace: Workspace): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.join(workspace.directory_path, SUMMARIES_DIR), { recursive: true });

    const now = new Date();
    const timeLabel = getLocalTime(now);
    const tz = getLocalTimezone();

    const sessionId = randomUUID();
    const session = createAgentSession(
      sessionId,
      {
        onEvent: () => {},
        onDone: () => {
          updateSessionTitle(sessionId, `Activity Summary — ${getLocalDate(now)}${tz ? ` (${tz})` : ''} ${timeLabel}`);
          log.info(`[HourlySummary] Agent session completed: ${sessionId}`);
          session.destroy();
          resolve();
        },
        onError: (error) => {
          log.error(`[HourlySummary] Agent session failed: ${error}`);
          session.destroy();
          reject(new Error(error));
        },
      },
      workspace,
    );

    session.sendMessage('Use the activity-summary skill to update the daily summary with recent activity.');
  });
}
