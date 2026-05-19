import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import {
  isConnected as isGoogleDocsConnected,
  disconnect as disconnectGoogleDocs,
  startOAuthFlow as startGoogleDocsOAuth,
  hasCredentials as googleDocsHasCredentials,
  hasDriveScope as googleDocsHasDriveScope,
} from '../googleDocsService';
import { listFiles as driveListFiles, generateDriveDirectoryTree } from '../googleDriveService';
import {
  listWorkspaceDirectoriesBySource,
  removeWorkspaceDirectoriesBySource,
  addWorkspaceDirectory,
} from '../db/workspaceRepository';
import { listChildEntries, clearWorkspaceCache } from '../db/googleDriveCacheRepository';
import { getDatabase } from '../db/database';
import type { WorkspaceController } from './WorkspaceController';

export interface GoogleDriveControllerDeps {
  workspaceController: WorkspaceController;
  containerService?: { isRunning(): boolean; start(mountMap: any): Promise<void> };
}

export class GoogleDriveController {
  private workspaceController: WorkspaceController;

  constructor(deps: GoogleDriveControllerDeps) {
    this.workspaceController = deps.workspaceController;
  }

  registerIpcHandlers(): void {
    // ---- Google Docs ----

    ipcMain.handle('googleDocs:status', () => ({
      connected: isGoogleDocsConnected(),
      hasCredentials: googleDocsHasCredentials(),
    }));

    ipcMain.handle('googleDocs:connect', async () => {
      try {
        await startGoogleDocsOAuth();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    });

    ipcMain.handle('googleDocs:disconnect', () => {
      disconnectGoogleDocs();
      return { success: true };
    });

    // ---- Google Drive ----

    ipcMain.handle('googleDrive:status', () => ({
      connected: isGoogleDocsConnected(),
      hasCredentials: googleDocsHasCredentials(),
      hasDriveScope: googleDocsHasDriveScope(),
    }));

    ipcMain.handle('googleDrive:listFolder', async (_event: any, folderId?: string) => {
      try {
        return await driveListFiles({ folderId, pageSize: 100, orderBy: 'folder,name' });
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    });

    ipcMain.handle('googleDrive:saveSelection', async (_event: any, selection: any) => {
      try {
        const wsId = this.workspaceController.workspaceId;
        if (!wsId) return { success: false, error: 'No active workspace' };
        const items: Array<{ id: string; name: string; mimeType: string; path: string }> = selection?.selectedItems ?? [];
        removeWorkspaceDirectoriesBySource(wsId, 'google-drive');
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          addWorkspaceDirectory(
            randomUUID(), wsId,
            `gdrive://${item.id}`,
            item.name, i,
            'google-drive',
            JSON.stringify({ driveId: item.id, mimeType: item.mimeType, path: item.path }),
          );
        }
        // Create cache subdirectories and generate the Drive tree for each
        // selected folder so children are immediately available in the file view.
        const cacheBase = path.resolve(this.workspaceController.driveCacheBaseDir);
        for (const item of items) {
          const subDir = path.resolve(cacheBase, item.name);
          if (!subDir.startsWith(cacheBase + path.sep)) {
            throw new Error('Invalid folder name');
          }
          fs.mkdirSync(subDir, { recursive: true });
          await generateDriveDirectoryTree(item.id, item.name, wsId);
        }
        this.workspaceController.loadActiveWorkspace();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    });

    ipcMain.handle('googleDrive:getSelection', () => {
      try {
        const wsId = this.workspaceController.workspaceId;
        if (!wsId) return { success: true, data: null };
        const dirs = listWorkspaceDirectoriesBySource(wsId, 'google-drive');
        const selectedItems = dirs.map(d => {
          const meta = d.metadata ? JSON.parse(d.metadata) : {};
          return { id: meta.driveId ?? '', name: d.display_name, mimeType: meta.mimeType ?? '', path: meta.path ?? '' };
        });
        return { success: true, data: selectedItems.length > 0 ? { selectedItems } : null };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    });

    ipcMain.handle('googleDrive:getCacheDirectories', () => {
      try {
        const wsId = this.workspaceController.workspaceId;
        if (!wsId) return null;
        const dirs = listWorkspaceDirectoriesBySource(wsId, 'google-drive');
        if (dirs.length === 0) return null;
        const hostPath = this.workspaceController.driveCacheBaseDir;
        fs.mkdirSync(hostPath, { recursive: true });
        return { hostPath };
      } catch {
        return null;
      }
    });

    ipcMain.handle('googleDrive:listChildren', (_event: any, parentId: string) => {
      try {
        const wsId = this.workspaceController.workspaceId;
        if (!wsId) return [];

        if (parentId === 'root') {
          const dirs = listWorkspaceDirectoriesBySource(wsId, 'google-drive');
          return dirs.map((d) => {
            const driveId = d.directory_path.replace('gdrive://', '');
            return {
              name: d.display_name,
              fileId: driveId,
              mimeType: 'application/vnd.google-apps.folder',
              isDirectory: true,
            };
          });
        }

        const entries = listChildEntries(wsId, parentId);
        return entries.map((e) => ({
          name: e.name,
          fileId: e.file_id,
          mimeType: e.mime_type,
          isDirectory: e.mime_type === 'application/vnd.google-apps.folder',
        }));
      } catch {
        return [];
      }
    });

    ipcMain.handle('googleDrive:listCacheEntries', () => {
      try {
        const wsId = this.workspaceController.workspaceId;
        if (!wsId) return [];
        const db = getDatabase();
        return db.prepare('SELECT * FROM google_drive_cache WHERE workspace_id = ? ORDER BY relative_path').all(wsId);
      } catch {
        return [];
      }
    });

    ipcMain.handle('googleDrive:refreshTree', async () => {
      try {
        const wsId = this.workspaceController.workspaceId;
        if (!wsId) return { success: false, error: 'No active workspace' };
        const dirs = listWorkspaceDirectoriesBySource(wsId, 'google-drive');
        if (dirs.length === 0) return { success: false, error: 'No Google Drive folders connected' };
        for (const d of dirs) {
          const driveId = d.directory_path.replace('gdrive://', '');
          await generateDriveDirectoryTree(driveId, d.display_name, wsId);
        }
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    });

    ipcMain.handle('googleDrive:resetCache', async () => {
      try {
        const wsId = this.workspaceController.workspaceId;
        if (!wsId) return { success: false, error: 'No active workspace' };
        clearWorkspaceCache(wsId);
        removeWorkspaceDirectoriesBySource(wsId, 'google-drive');
        const cacheDir = path.resolve(this.workspaceController.driveCacheBaseDir);
        const expectedParent = path.resolve(app.getPath('userData'));
        if (!cacheDir.startsWith(expectedParent + path.sep)) {
          return { success: false, error: 'Invalid cache directory path' };
        }
        await fsPromises.rm(cacheDir, { recursive: true, force: true });
        // Re-create the base dir so the existing container mount stays valid
        fs.mkdirSync(cacheDir, { recursive: true });
        this.workspaceController.loadActiveWorkspace();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    });
  }
}
