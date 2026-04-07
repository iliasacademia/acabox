import log from 'electron-log';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createAgentSession } from '../agentSession';
import { updateSessionTitle } from '../db/chatRepository';
import type { Workspace } from '../../shared/types';

const SCRATCHPAD_DIR = '.academia';
const SCRATCHPAD_FILE = 'hourly-scratchpad.md';
const SUMMARIES_DIR = 'summaries';

function archiveIfNewDay(workspacePath: string): void {
  const scratchpadPath = path.join(workspacePath, SCRATCHPAD_DIR, SCRATCHPAD_FILE);
  let scratchpad: string;
  try {
    scratchpad = fs.readFileSync(scratchpadPath, 'utf-8');
  } catch {
    return;
  }

  if (!scratchpad) return;

  const today = new Date().toISOString().slice(0, 10);
  const dateMatch = scratchpad.match(/^# Activity Summary — (\d{4}-\d{2}-\d{2})/);
  if (!dateMatch || dateMatch[1] === today) return;

  const archiveDir = path.join(workspacePath, SCRATCHPAD_DIR, SUMMARIES_DIR);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, `${dateMatch[1]}.md`),
    scratchpad,
    'utf-8',
  );

  fs.unlinkSync(scratchpadPath);
  log.info(`[HourlySummary] Archived scratchpad for ${dateMatch[1]}`);
}

export function runSummaryAgent(workspace: Workspace): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.join(workspace.directory_path, SCRATCHPAD_DIR), { recursive: true });
    archiveIfNewDay(workspace.directory_path);

    const now = new Date();
    const timeLabel = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const sessionId = randomUUID();
    const session = createAgentSession(
      sessionId,
      {
        onEvent: () => {},
        onDone: () => {
          updateSessionTitle(sessionId, `Activity Summary — ${now.toISOString().slice(0, 10)} ${timeLabel}`);
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

    session.sendMessage('Use the activity-summary skill to update the activity scratchpad with recent activity.');
  });
}
