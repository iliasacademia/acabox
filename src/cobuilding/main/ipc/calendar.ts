import { dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupTimeRange,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  addEventFile,
  listEventFiles,
  removeEventFile,
  addGroupFile,
  listGroupFiles,
  removeGroupFile,
  getEvent,
} from '../db/calendarRepository';
import {
  createDependency,
  listDependenciesByWorkspace,
  updateDependency,
  deleteDependency,
  hasCycle,
  applyCascade,
  adjustBufferAndCascade,
} from '../db/dependencyRepository';
import {
  createResource,
  listResources,
  updateResource,
  moveResource,
  deleteResource,
} from '../db/resourceRepository';
import { getActiveWorkspace } from '../db/workspaceRepository';

function cascadeUpdatesWithEvents(updates: any[], events: any[]) {
  return updates.map(u => {
    const ev = events.find((e: any) => e.id === u.eventId);
    return { ...u, event: ev ?? null };
  });
}

export function registerCalendarHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('calendar:listGroups', async () => {
    const ws = getActiveWorkspace();
    if (!ws) return [];
    return listGroups(ws.id);
  });

  ipcMain.handle('calendar:createGroup', async (_event, data) => {
    const ws = getActiveWorkspace();
    if (!ws) throw new Error('No active workspace');
    const group = createGroup(ws.id, data);
    _event.sender.send('calendar:mutation', { type: 'group-created', group });
    return group;
  });

  ipcMain.handle('calendar:updateGroup', async (_event, id: string, data) => {
    return updateGroup(id, data) ?? null;
  });

  ipcMain.handle('calendar:deleteGroup', async (_event, id: string) => {
    deleteGroup(id);
  });

  ipcMain.handle('calendar:getGroupTimeRange', async (_event, id: string) => {
    return getGroupTimeRange(id);
  });

  ipcMain.handle('calendar:listEvents', async (_event, opts) => {
    const ws = getActiveWorkspace();
    if (!ws) return [];
    return listEvents(ws.id, opts ?? {});
  });

  ipcMain.handle('calendar:createEvent', async (_event, data) => {
    const ws = getActiveWorkspace();
    if (!ws) throw new Error('No active workspace');
    const event = createEvent(ws.id, data);
    _event.sender.send('calendar:mutation', { type: 'event-created', event });
    return event;
  });

  ipcMain.handle('calendar:updateEvent', async (_event, id: string, data) => {
    return updateEvent(id, data) ?? null;
  });

  ipcMain.handle('calendar:deleteEvent', async (_event, id: string) => {
    deleteEvent(id);
  });

  ipcMain.handle('calendar:addEventFile', async (_event, eventId: string, filePath: string) => {
    return addEventFile(eventId, filePath);
  });

  ipcMain.handle('calendar:listEventFiles', async (_event, eventId: string) => {
    return listEventFiles(eventId);
  });

  ipcMain.handle('calendar:removeEventFile', async (_event, id: number) => {
    removeEventFile(id);
  });

  ipcMain.handle('calendar:addGroupFile', async (_event, groupId: string, filePath: string) => {
    return addGroupFile(groupId, filePath);
  });

  ipcMain.handle('calendar:listGroupFiles', async (_event, groupId: string, includeFromEvents?: boolean) => {
    return listGroupFiles(groupId, includeFromEvents);
  });

  ipcMain.handle('calendar:removeGroupFile', async (_event, id: number) => {
    removeGroupFile(id);
  });

  ipcMain.handle('calendar:listResources', async (_event, opts) => {
    const ws = getActiveWorkspace();
    if (!ws) return [];
    return listResources(ws.id, opts ?? {});
  });

  ipcMain.handle('calendar:createResource', async (_event, data) => {
    const ws = getActiveWorkspace();
    if (!ws) throw new Error('No active workspace');
    return createResource(ws.id, data);
  });

  ipcMain.handle('calendar:updateResource', async (_event, id: string, data) => {
    return updateResource(id, data) ?? null;
  });

  ipcMain.handle('calendar:deleteResource', async (_event, id: string) => {
    deleteResource(id);
  });

  ipcMain.handle('calendar:openResourceFile', async (_event, filePath: string) => {
    return shell.openPath(filePath);
  });

  ipcMain.handle('calendar:openResourceUrl', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('calendar:revealResourceFile', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('calendar:moveResource', async (_event, id: string, data) => {
    return moveResource(id, data) ?? null;
  });

  ipcMain.handle('calendar:listWorkspaceFiles', async () => {
    const ws = getActiveWorkspace();
    if (!ws) return [];
    const baseDir = ws.directory_path;
    const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.applications', '.academia']);
    function walk(dir: string, depth: number): { name: string; path: string; isDir: boolean; children?: unknown[] }[] {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
          .map(e => {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && depth < 2) {
              return { name: e.name, path: full, isDir: true, children: walk(full, depth + 1) };
            }
            return { name: e.name, path: full, isDir: e.isDirectory() };
          });
      } catch { return []; }
    }
    return walk(baseDir, 0);
  });

  ipcMain.handle('calendar:pickResourceFile', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? null : result.filePaths;
  });

  ipcMain.handle('calendar:listDependencies', async () => {
    const ws = getActiveWorkspace();
    if (!ws) return [];
    return listDependenciesByWorkspace(ws.id);
  });

  ipcMain.handle('calendar:createDependency', async (_event, data) => {
    if (hasCycle(data.predecessor_id, data.successor_id)) {
      return { error: 'cycle' };
    }
    return createDependency(data);
  });

  ipcMain.handle('calendar:updateDependency', async (_event, id: string, data) => {
    return updateDependency(id, data) ?? null;
  });

  ipcMain.handle('calendar:deleteDependency', async (_event, id: string) => {
    deleteDependency(id);
  });

  ipcMain.handle('calendar:moveEventWithCascade', async (_event, id: string, newStartAt: string, newEndAt: string) => {
    const moved = updateEvent(id, { start_at: newStartAt, end_at: newEndAt });
    if (!moved) return null;
    const cascaded = applyCascade(id);
    const cascadedEvents = cascaded.map(u => getEvent(u.eventId)).filter(Boolean);
    return { moved, cascaded: cascadeUpdatesWithEvents(cascaded, cascadedEvents as any[]) };
  });

  ipcMain.handle('calendar:adjustBuffer', async (_event, depId: string, newLagCurrentMs: number) => {
    return adjustBufferAndCascade(depId, newLagCurrentMs);
  });
}
