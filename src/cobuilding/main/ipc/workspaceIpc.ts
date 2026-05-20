import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { WorkspaceController } from '../controllers/WorkspaceController';
import type { containerService as containerServiceInstance } from '../containerService';
import type { AgentInfrastructureController } from '../controllers/AgentInfrastructureController';

export function registerWorkspaceHandlers(
  workspace: WorkspaceController,
  getMainWindow: () => BrowserWindow | null,
  containerService?: typeof containerServiceInstance,
  agentInfrastructure?: AgentInfrastructureController,
): void {
  const sendContainerProgress = (stage: string, message: string, percent?: number) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('container:progress', { stage, message, percent });
    }
  };
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
      await containerService.start(workspace.mountMap, sendContainerProgress);
      await agentInfrastructure?.start(workspace.workspacePath);
    }
    return dir;
  });
  ipcMain.handle('workspaces:removeDirectory', async (_event, directoryId: string) => {
    workspace.removeDirectory(directoryId);
    if (containerService?.isRunning()) {
      await containerService.start(workspace.mountMap, sendContainerProgress);
      await agentInfrastructure?.start(workspace.workspacePath);
    }
  });
  ipcMain.handle('workspaces:updateDirectoryPermission', async (_event, directoryId: string, readOnly: boolean) => {
    const dir = workspace.updateDirectoryPermission(directoryId, readOnly);
    if (containerService?.isRunning()) {
      await containerService.start(workspace.mountMap, sendContainerProgress);
      await agentInfrastructure?.start(workspace.workspacePath);
    }
    return dir;
  });
}
