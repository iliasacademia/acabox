import { app, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { startBrowserMonitor, stopBrowserMonitor, isBrowserMonitorRunning } from '../browserMonitor';
import { browserExtensionServer } from '../../../server/browserExtensionServer';
import {
  getTaskBySessionSource,
  createTask,
  updateTask,
  setTaskEnabled,
} from '../db/scheduledTaskRepository';
import { getTaskScheduler } from '../scheduledTasks';
import type { Workspace } from '../../shared/types';

type ReactionSource = 'browser' | 'file';
const DEFAULT_REACTION_SOURCES: ReactionSource[] = ['browser', 'file'];

const DEFAULT_ACTIVITY_SUMMARY_PROMPT =
  'Complete ALL of the following steps in order:\n' +
  '\n' +
  '1. Use the activity-summary skill to add an update to today\'s daily summary with activity since the last update.\n' +
  '2. Use the reaction skill to react to the latest update only with suggestions and relevant resources. ' +
  'The reaction skill will handle creating the user-visible reaction thread and sending the notification.';

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(data: Record<string, unknown>): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function patchSettings(patch: Record<string, unknown>): void {
  const data = readSettings();
  Object.assign(data, patch);
  writeSettings(data);
}

// ── Reactions enabled ───────────────────────────────────────────────

export function getReactionsEnabled(): boolean {
  return readSettings().reactionsEnabled === true;
}

function setReactionsEnabledSetting(enabled: boolean): void {
  patchSettings({ reactionsEnabled: enabled });
}

// ── Reactions task ──────────────────────────────────────────────────

export function ensureReactionsTask(workspaceId: string): void {
  const existing = getTaskBySessionSource(workspaceId, 'reactions-system');
  if (existing) return;
  createTask(workspaceId, 'Reactions', 'Summarizes your recent activity every 15 minutes',
    DEFAULT_ACTIVITY_SUMMARY_PROMPT, '*/15 * * * *', 'reactions-system');
}

// ── Reaction user instructions ──────────────────────────────────────

function getReactionUserInstructions(): string | null {
  return (readSettings().reactionUserInstructions as string) ?? null;
}

function setReactionUserInstructions(instructions: string): void {
  patchSettings({ reactionUserInstructions: instructions });
}

function clearReactionUserInstructions(): void {
  const data = readSettings();
  delete data.reactionUserInstructions;
  writeSettings(data);
}

// ── Reaction sources ────────────────────────────────────────────────

export function getReactionSources(): ReactionSource[] {
  return (readSettings().reactionSources as ReactionSource[]) ?? DEFAULT_REACTION_SOURCES;
}

export function setReactionSources(sources: ReactionSource[]): void {
  patchSettings({ reactionSources: sources });
}

function buildReactionsPrompt(sources: ReactionSource[]): string {
  const sourceFilter = sources.length === 2 ? 'all' : sources.join(',');
  return 'Complete ALL of the following steps in order:\n' +
    '\n' +
    '1. Use the activity-summary skill to add an update to today\'s daily summary with activity since the last update. ' +
    `When querying activity, set source to "${sourceFilter}".\n` +
    '2. Use the reaction skill to react to the latest update only with suggestions and relevant resources. ' +
    'The reaction skill will handle creating the user-visible reaction thread and sending the notification.';
}

export function updateReactionsTaskPrompt(workspaceId: string, sources: ReactionSource[]): void {
  const task = getTaskBySessionSource(workspaceId, 'reactions-system');
  if (!task) return;
  updateTask(task.id, { prompt: buildReactionsPrompt(sources) });
}

// ── IPC registration ────────────────────────────────────────────────

export function registerReactionsHandlers(
  getActiveWorkspace: () => Workspace | null,
  rebuildTrayMenu: () => void,
): void {
  // Reaction prompt
  ipcMain.handle('reactionPrompt:get', () => {
    return { instructions: getReactionUserInstructions() };
  });

  ipcMain.handle('reactionPrompt:set', (_event, instructions: string) => {
    setReactionUserInstructions(instructions);
  });

  ipcMain.handle('reactionPrompt:reset', () => {
    clearReactionUserInstructions();
  });

  // Reaction sources
  ipcMain.handle('reactionSources:get', () => {
    return getReactionSources();
  });

  ipcMain.handle('reactionSources:set', (_event, sources: ReactionSource[]) => {
    setReactionSources(sources);
    const workspace = getActiveWorkspace();
    if (workspace) {
      updateReactionsTaskPrompt(workspace.id, sources);
      const task = getTaskBySessionSource(workspace.id, 'reactions-system');
      if (task) {
        getTaskScheduler()?.scheduleTask(task.id);
      }
    }
  });

  // Reactions enabled
  ipcMain.handle('settings:getReactionsEnabled', () => {
    return getReactionsEnabled();
  });

  ipcMain.handle('settings:setReactionsEnabled', async (_event, enabled: boolean) => {
    setReactionsEnabledSetting(enabled);
    const workspace = getActiveWorkspace();
    if (enabled) {
      if (!isBrowserMonitorRunning()) {
        await startBrowserMonitor();
        rebuildTrayMenu();
      }
      if (workspace) {
        ensureReactionsTask(workspace.id);
        const task = getTaskBySessionSource(workspace.id, 'reactions-system');
        if (task) {
          setTaskEnabled(task.id, true);
          getTaskScheduler()?.scheduleTask(task.id);
        }
      }
    } else {
      await stopBrowserMonitor();
      rebuildTrayMenu();
      if (workspace) {
        const task = getTaskBySessionSource(workspace.id, 'reactions-system');
        if (task) {
          setTaskEnabled(task.id, false);
          getTaskScheduler()?.unscheduleTask(task.id);
        }
      }
    }
  });

  // Browser monitor
  ipcMain.handle('browserMonitor:status', () => {
    return {
      serverRunning: isBrowserMonitorRunning(),
      extensionConnected: browserExtensionServer.isConnected(),
    };
  });

  ipcMain.handle('browserMonitor:start', async () => {
    if (!isBrowserMonitorRunning()) {
      await startBrowserMonitor();
      rebuildTrayMenu();
    }
  });

  ipcMain.handle('browserMonitor:stop', async () => {
    await stopBrowserMonitor();
    rebuildTrayMenu();
  });

  ipcMain.handle('browserMonitor:downloadExtension', async () => {
    const zipPath = app.isPackaged
      ? path.join(process.resourcesPath, 'extension.zip')
      : path.join(app.getAppPath(), 'browser-extension', 'extension.zip');

    if (!fs.existsSync(zipPath)) {
      return { success: false, error: 'Browser extension zip not found' };
    }

    const destDir = app.getPath('downloads');
    const destPath = path.join(destDir, 'academia-browser-extension.zip');
    fs.copyFileSync(zipPath, destPath);
    shell.showItemInFolder(destPath);
    return { success: true, path: destPath };
  });
}
