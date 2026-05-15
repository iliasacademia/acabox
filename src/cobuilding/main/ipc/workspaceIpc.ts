import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { WorkspaceController } from '../controllers/WorkspaceController';
import type { containerService as containerServiceInstance } from '../containerService';

export function registerWorkspaceHandlers(
  workspace: WorkspaceController,
  getMainWindow: () => BrowserWindow | null,
  containerService?: typeof containerServiceInstance,
): void {
  ipcMain.handle('workspaces:getActive', () => {
    const ws = workspace.activeWorkspace;
    if (!ws) return null;
    return {
      ...ws,
      directory_path: workspace.workspacePath,
      user_directory_paths: workspace.userDirectoryPaths,
    };
  });
  ipcMain.handle('dialog:selectDirectory', async () => {
    const win = getMainWindow();
    if (!win) return undefined;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return undefined;
    return result.filePaths[0];
  });
  ipcMain.handle('workspaces:addDirectory', async (_event, directoryPath: string) => {
    const dir = workspace.addDirectory(directoryPath);
    if (containerService?.isRunning()) {
      await containerService.start(workspace.mountMap);
    }
    return dir;
  });
  ipcMain.handle('workspaces:removeDirectory', async (_event, directoryId: string) => {
    workspace.removeDirectory(directoryId);
    if (containerService?.isRunning()) {
      await containerService.start(workspace.mountMap);
    }
  });
}
