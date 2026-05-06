import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crossZip = require('cross-zip');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const extractZip = require('extract-zip');
import { execFile } from 'child_process';

const MAX_FILE_SIZE = 10_000_000; // 10 MB
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif']);
// PDFs are streamed via the local-file protocol, so the 10 MB read limit doesn't apply.
const PDF_EXTENSIONS = new Set(['pdf']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkdn', 'mkd']);
const CSV_EXTENSIONS = new Set(['csv', 'tsv']);
const LATEX_EXTENSIONS = new Set(['tex', 'latex']);
// Modern Excel formats parsed by ExcelJS in the renderer. Legacy .xls (binary)
// and .ods are not supported by ExcelJS and would fail at parse time.
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xlsm']);
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.config', '.password-store']);

export function assertWithinWorkspace(filePath: string, workspaceDir: string): string {
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

  ipcMain.handle('files:exists', async (_event, filePath: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    try {
      const resolved = assertWithinWorkspace(filePath, workspaceDir);
      await fsPromises.access(resolved);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('files:findByName', async (_event, filename: string, hintDirs: string[]) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);

    // Try hint directories first (from message context)
    for (const hint of hintDirs) {
      try {
        const candidate = path.join(hint, filename);
        const resolved = assertWithinWorkspace(candidate, workspaceDir);
        await fsPromises.access(resolved);
        return candidate;
      } catch { /* continue */ }
    }

    // Fall back: recursive search, prefer most recently modified
    const entries = await fsPromises.readdir(workspaceDir, { recursive: true, withFileTypes: true });
    const matches: { rel: string; mtime: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && entry.name === filename) {
        const full = path.join(entry.parentPath, entry.name);
        const rel = path.relative(workspaceDir, full);
        try {
          const stat = await fsPromises.stat(full);
          matches.push({ rel, mtime: stat.mtimeMs });
        } catch { /* skip */ }
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0].rel;
  });

  ipcMain.handle('files:readFile', async (_event, filePath: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const resolved = assertWithinWorkspace(filePath, workspaceDir);

    const ext = path.extname(resolved).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      return { type: 'image' as const, fileUrl: `local-file://${resolved}` };
    }
    if (PDF_EXTENSIONS.has(ext)) {
      // PDFs render in an iframe via the local-file protocol — no in-process read needed.
      return { type: 'pdf' as const, fileUrl: `local-file://${resolved}` };
    }

    const stats = await fsPromises.stat(resolved);
    if (stats.size > MAX_FILE_SIZE) {
      return { error: 'too-large' as const, size: stats.size };
    }

    if (SPREADSHEET_EXTENSIONS.has(ext)) {
      // Excel/ODS files are binary. Read as a buffer and send base64 over IPC;
      // SheetJS in the renderer parses base64 directly.
      const buffer = await fsPromises.readFile(resolved);
      return { type: 'spreadsheet' as const, base64: buffer.toString('base64'), ext };
    }

    const content = await fsPromises.readFile(resolved, 'utf-8');
    if (MARKDOWN_EXTENSIONS.has(ext)) {
      return { type: 'markdown' as const, content };
    }
    if (CSV_EXTENSIONS.has(ext)) {
      // Empty delimiter triggers Papa Parse auto-detection (handles ',', ';', '|', etc.).
      // For .tsv we force tab since the extension is unambiguous.
      return { type: 'csv' as const, content, delimiter: ext === 'tsv' ? '\t' : '' };
    }
    if (LATEX_EXTENSIONS.has(ext)) {
      return { type: 'latex' as const, content };
    }
    return { type: 'text' as const, content };
  });

  ipcMain.handle(
    'files:copyToWorkspace',
    async (event, sourcePaths: string[], destinationDir: string) => {
      const workspaceDir = requireWorkspace(getWorkspacePath);
      const resolvedDir = assertWithinWorkspace(destinationDir, workspaceDir);
      await fsPromises.mkdir(resolvedDir, { recursive: true });

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

  ipcMain.handle('files:revealInFinder', async (_event, filePath: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const resolved = assertWithinWorkspace(filePath, workspaceDir);
    shell.showItemInFolder(resolved);
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

  ipcMain.handle('miniApps:list', async () => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const appsDir = path.join(workspaceDir, '.applications');

    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(appsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const apps = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
        .map(async (e) => {
          const dirName = e.name;
          const manifestPath = path.join(appsDir, dirName, 'manifest.json');
          let manifest: { name?: unknown; description?: unknown; icon?: unknown; lastOpened?: unknown; preBuilt?: unknown } | null = null;
          try {
            const raw = await fsPromises.readFile(manifestPath, 'utf-8');
            manifest = JSON.parse(raw);
          } catch {
            // missing or unreadable — fall through to dir-name fallback
          }
          const fallbackName = dirName.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
          return {
            dirName,
            name: typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name : fallbackName,
            description: typeof manifest?.description === 'string' ? manifest.description : null,
            icon: typeof manifest?.icon === 'string' ? manifest.icon : null,
            lastOpened: typeof manifest?.lastOpened === 'string' ? manifest.lastOpened : null,
            preBuilt: manifest?.preBuilt === true,
            hasManifest: manifest !== null,
          };
        }),
    );

    return apps;
  });

  ipcMain.handle('miniApps:touch', async (_event, dirName: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
      return { ok: false, error: 'Invalid app name' };
    }
    const manifestPath = path.join(workspaceDir, '.applications', dirName, 'manifest.json');

    let manifest: Record<string, unknown> = {};
    try {
      const raw = await fsPromises.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') manifest = parsed;
    } catch {
      // No manifest yet — the migration will fill in name/description/icon
      // later. Touching just records the lastOpened timestamp; the rest stays
      // missing until the migration job (or skill) writes it.
    }

    manifest.lastOpened = new Date().toISOString();

    try {
      await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle('miniApps:export', async (_event, dirName: string) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const mainWindow = getMainWindow();
    if (!mainWindow) return { ok: false, error: 'No main window' };

    if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
      return { ok: false, error: 'Invalid app name' };
    }

    const appDir = path.join(workspaceDir, '.applications', dirName);
    try {
      await fsPromises.stat(appDir);
    } catch {
      return { ok: false, error: 'App not found' };
    }

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(os.homedir(), `${dirName}.zip`),
      filters: [{ name: 'Mini App', extensions: ['zip'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { ok: false, canceled: true };

    const outZip = saveResult.filePath.endsWith('.zip') ? saveResult.filePath : `${saveResult.filePath}.zip`;
    const tmpDir = path.join(os.tmpdir(), `academia-export-${Date.now()}`);
    const tmpAppDir = path.join(tmpDir, dirName);

    try {
      await fsPromises.mkdir(tmpAppDir, { recursive: true });

      // Copy full app contents
      await fsPromises.cp(appDir, tmpAppDir, { recursive: true });

      await new Promise<void>((resolve, reject) => {
        crossZip.zip(tmpAppDir, outZip, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      return { ok: true, savedPath: outZip };
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle('miniApps:import', async (_event) => {
    const workspaceDir = requireWorkspace(getWorkspacePath);
    const mainWindow = getMainWindow();
    if (!mainWindow) return { ok: false, error: 'No main window' };

    const openResult = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Mini App', extensions: ['zip'] }],
    });
    if (openResult.canceled || openResult.filePaths.length === 0) return { ok: false, canceled: true };

    const zipPath = openResult.filePaths[0];
    const tmpDir = path.join(os.tmpdir(), `academia-import-${Date.now()}`);

    try {
      await fsPromises.mkdir(tmpDir, { recursive: true });
      await extractZip(zipPath, { dir: tmpDir });

      const extracted = await fsPromises.readdir(tmpDir, { withFileTypes: true });
      const appDirs = extracted.filter((e) => e.isDirectory());
      if (appDirs.length === 0) return { ok: false, error: 'No app directory found in zip' };

      const baseName = appDirs[0].name;
      const sourceDir = path.join(tmpDir, baseName);
      const appsDir = path.join(workspaceDir, '.applications');
      await fsPromises.mkdir(appsDir, { recursive: true });

      // Find a non-colliding name
      let finalDirName = baseName;
      let suffix = 1;
      for (;;) {
        try {
          await fsPromises.stat(path.join(appsDir, finalDirName));
          finalDirName = `${baseName}_${suffix++}`;
        } catch {
          break;
        }
      }

      await fsPromises.cp(sourceDir, path.join(appsDir, finalDirName), { recursive: true });
      return { ok: true, dirName: finalDirName };
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle('image:convertToPng', async (_event, base64Data: string) => {
    const tmpInput = path.join(require('os').tmpdir(), `convert-${Date.now()}.tiff`);
    const tmpOutput = path.join(require('os').tmpdir(), `convert-${Date.now()}.png`);
    try {
      await fsPromises.writeFile(tmpInput, Buffer.from(base64Data, 'base64'));
      await new Promise<void>((resolve, reject) => {
        execFile('sips', ['-s', 'format', 'png', tmpInput, '--out', tmpOutput], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const pngBuffer = await fsPromises.readFile(tmpOutput);
      return pngBuffer.toString('base64');
    } finally {
      fsPromises.rm(tmpInput, { force: true }).catch(() => {});
      fsPromises.rm(tmpOutput, { force: true }).catch(() => {});
    }
  });

  // --- Workspace file watcher ---
  // Watch the workspace directory for changes (files created/deleted by
  // container commands, etc.) and notify the renderer so the file tree
  // refreshes automatically.
  const WATCHER_DEBOUNCE_MS = 1000;
  let watcher: fs.FSWatcher | null = null;
  let watchedPath: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function startWatcher(): void {
    const workspaceDir = getWorkspacePath();
    if (!workspaceDir || watchedPath === workspaceDir) return;

    // Clean up previous watcher if workspace changed
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    watchedPath = workspaceDir;

    try {
      watcher = fs.watch(workspaceDir, { recursive: true }, () => {
        // Debounce: many events fire in rapid succession during a script run
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('files:workspaceChanged');
          }
        }, WATCHER_DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        // Silently ignore watcher errors (e.g., directory deleted)
        if (watcher) { watcher.close(); watcher = null; }
      });
    } catch {
      // fs.watch may not be supported on all platforms/filesystems
    }
  }

  // Start the watcher after a short delay (workspace may not be set yet at registration time)
  setTimeout(startWatcher, 2000);
  // Re-check periodically in case the workspace changes
  setInterval(startWatcher, 10000);
}
