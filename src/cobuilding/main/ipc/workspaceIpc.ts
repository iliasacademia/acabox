import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { WorkspaceController } from '../controllers/WorkspaceController';

export function registerWorkspaceHandlers(
  workspace: WorkspaceController,
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle('workspaces:getActive', () => workspace.activeWorkspace ?? null);
  ipcMain.handle('workspaces:getDefaultDirectory', (_event, name: string) => workspace.getDefaultDirectory(name));
  ipcMain.handle('dialog:selectDirectory', async () => {
    const win = getMainWindow();
    if (!win) return undefined;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return undefined;
    return result.filePaths[0];
  });
}
