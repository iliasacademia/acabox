import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

const MAX_FILE_SIZE = 10_000_000; // 10 MB
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.config', '.password-store']);

function assertWithinWorkspace(filePath: string, workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir, filePath);
  if (!resolved.startsWith(workspaceDir + path.sep) && resolved !== workspaceDir) {
    throw new Error('Access denied: path is outside the workspace directory.');
  }
  const relative = path.relative(workspaceDir, resolved);
  const firstSegment = relative.split(path.sep)[0];
  if (SENSITIVE_DIRS.has(firstSegment)) {
    throw new Error('Access denied: cannot access sensitive directories.');
  }
  return resolved;
}

function validateFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid file name.');
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error('File name contains invalid characters.');
  }
  if (trimmed.length > 255) {
    throw new Error('File name is too long.');
  }
  return trimmed;
}

function requireWorkspace(getWorkspacePath: () => string | null): string {
  const wp = getWorkspacePath();
  if (!wp) throw new Error('No active workspace.');
  return wp;
}

export function registerFileHandlers(getWorkspacePath: () => string | null, getMainWindow: () => BrowserWindow | null): void {
  // Tracks the last directory the user navigated to in any file dialog.
  // Falls back to the workspace directory on first use.
  let lastDialogDir: string | null = null;

  function getDialogDir(): string | undefined {
    return lastDialogDir ?? getWorkspacePath() ?? undefined;
  }

  function updateDialogDir(filePath: string): void {
    lastDialogDir = path.dirname(filePath);
  }

  ipcMain.handle('files:readDirectory', async (_event, dirPath: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const resolved = assertWithinWorkspace(dirPath, workspaceDir);

    const entries = await fsPromises.readdir(resolved, { withFileTypes: true });
    return entries
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => ({
        name: e.name,
        path: path.join(resolved, e.name),
        isDirectory: e.isDirectory(),
      }));
  });

  ipcMain.handle('files:readFile', async (_event, filePath: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const resolved = assertWithinWorkspace(filePath, workspaceDir);

    const ext = path.extname(resolved).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      return { type: 'image' as const, fileUrl: `local-file://${resolved}` };
    }

    const stats = await fsPromises.stat(resolved);
    if (stats.size > MAX_FILE_SIZE) {
      return { error: 'too-large' as const, size: stats.size };
    }

    const content = await fsPromises.readFile(resolved, 'utf-8');
    return { type: 'text' as const, content };
  });

  ipcMain.handle(
    'files:copyToWorkspace',
    async (event, sourcePaths: string[], destinationDir: string) => {
      const workspaceDir = requireWorkspace(getWorkspacePath);
      const resolvedDir = assertWithinWorkspace(destinationDir, workspaceDir);

      const total = sourcePaths.length;
      let copied = 0;
      for (const src of sourcePaths) {
        const basename = path.basename(src);
        event.sender.send('files:copyProgress', { copied, total, currentName: basename });
        const dest = path.join(resolvedDir, basename);
        assertWithinWorkspace(dest, workspaceDir);
        const stat = await fsPromises.stat(src);
        if (stat.isDirectory()) {
          await fsPromises.cp(src, dest, { recursive: true });
        } else {
          await fsPromises.copyFile(src, dest);
        }
        copied++;
      }
      event.sender.send('files:copyProgress', { copied, total, currentName: null });
      return { copied };
    },
  );

  ipcMain.handle(
    'files:moveFile',
    async (_event, sourcePath: string, destinationDir: string) => {
      const workspaceDir = requireWorkspace(getWorkspacePath);
      const resolvedSrc = assertWithinWorkspace(sourcePath, workspaceDir);
      const resolvedDir = assertWithinWorkspace(destinationDir, workspaceDir);

      const basename = path.basename(resolvedSrc);
      const dest = path.join(resolvedDir, basename);
      assertWithinWorkspace(dest, workspaceDir);
      await fsPromises.rename(resolvedSrc, dest);
    },
  );

  ipcMain.handle('files:deleteFile', async (_event, filePath: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const resolved = assertWithinWorkspace(filePath, workspaceDir);
    await fsPromises.rm(resolved, { recursive: true });
  });

  ipcMain.handle(
    'files:renameFile',
    async (_event, filePath: string, newName: string) => {
      const workspaceDir = requireWorkspace(getWorkspacePath);
      const resolved = assertWithinWorkspace(filePath, workspaceDir);
      const validName = validateFileName(newName);
      const newPath = path.join(path.dirname(resolved), validName);
      assertWithinWorkspace(newPath, workspaceDir);
      await fsPromises.rename(resolved, newPath);
    },
  );

  ipcMain.handle(
    'files:createFile',
    async (_event, filePath: string) => {
      const workspaceDir = requireWorkspace(getWorkspacePath);
      const resolved = assertWithinWorkspace(filePath, workspaceDir);
      validateFileName(path.basename(resolved));
      await fsPromises.writeFile(resolved, '', { flag: 'wx' });
    },
  );

  ipcMain.handle(
    'files:createDirectory',
    async (_event, dirPath: string) => {
      const workspaceDir = requireWorkspace(getWorkspacePath);
      const resolved = assertWithinWorkspace(dirPath, workspaceDir);
      validateFileName(path.basename(resolved));
      await fsPromises.mkdir(resolved);
    },
  );

  ipcMain.handle(
    'files:writeFile',
    async (_event, filePath: string, content: string) => {
      const workspaceDir = requireWorkspace(getWorkspacePath);
      const resolved = assertWithinWorkspace(filePath, workspaceDir);
      await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
      await fsPromises.writeFile(resolved, content, 'utf-8');
    },
  );

  ipcMain.handle(
    'files:downloadFile',
    async (_event, filename: string, content: string) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return { ok: false, error: 'No main window' };

      const dir = getDialogDir();
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: dir ? path.join(dir, filename) : filename,
      });

      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }

      updateDialogDir(result.filePath);
      await fsPromises.writeFile(result.filePath, content, 'utf-8');
      return { ok: true, savedPath: result.filePath };
    },
  );

  ipcMain.handle('files:showInFinder', async (_event, filePath: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const resolved = assertWithinWorkspace(filePath, workspaceDir);
    await shell.openPath(resolved);
  });

  ipcMain.handle('files:selectFile', async (_event, filters?: { name: string; extensions: string[] }[]) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: getDialogDir(),
      properties: ['openFile'],
      filters: filters ?? undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    updateDialogDir(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('files:selectDirectory', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: getDialogDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    updateDialogDir(result.filePaths[0]);
    return result.filePaths[0];
  });
}
