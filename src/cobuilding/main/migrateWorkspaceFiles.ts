import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

export function migrateWorkspaceFiles(workspacePath: string): void {
  const oldDirs = ['file-snapshots', 'session-files'];
  const newDir = path.join(workspacePath, '.academia', 'temp_files');

  let needsMigration = false;
  for (const dir of oldDirs) {
    if (fs.existsSync(path.join(workspacePath, dir))) {
      needsMigration = true;
      break;
    }
  }
  if (!needsMigration) return;

  fs.mkdirSync(newDir, { recursive: true });

  for (const dir of oldDirs) {
    const oldPath = path.join(workspacePath, dir);
    if (!fs.existsSync(oldPath)) continue;

    const files = fs.readdirSync(oldPath);
    for (const file of files) {
      const src = path.join(oldPath, file);
      const dest = path.join(newDir, file);
      try {
        fs.renameSync(src, dest);
      } catch (err) {
        log.warn('[Migration] Failed to move file:', src, err);
      }
    }

    try {
      fs.rmdirSync(oldPath);
      log.info('[Migration] Removed old directory:', oldPath);
    } catch (err) {
      log.warn('[Migration] Failed to remove old directory:', oldPath, err);
    }
  }

  log.info('[Migration] Migrated workspace files to .academia/temp_files');
}
