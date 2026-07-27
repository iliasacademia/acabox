import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import { APPLICATIONS_DIR, TOOL_DATA_DIR, TOOL_DATA_SUBDIRS } from '../shared/paths';

/**
 * Enforces the "code vs data" split layout for mini-apps.
 *
 * A tool's working files live under `<workspace>/tool-data/<dir>/{input,output}/`
 * (durable). The tool's code dir `<workspace>/.applications/<dir>/` reaches them
 * through symlinks (`input` -> `../../tool-data/<dir>/input`, likewise `output`),
 * so every existing path convention (`.applications/<dir>/output/...`) keeps
 * working transparently while a delete of `.applications/<dir>/` removes only the
 * symlinks — never the data behind them.
 *
 * Both entry points are idempotent and safe to run on every boot.
 */

/** Relative symlink target from `.applications/<dir>/<sub>` to the data dir. */
function symlinkTarget(dirName: string, sub: string): string {
  // Link lives at `.applications/<dir>/<sub>`, so its base dir is
  // `.applications/<dir>/` — go up two to the workspace root, then into tool-data.
  return path.join('..', '..', TOOL_DATA_DIR, dirName, sub);
}

/** Move the contents of `src` into `dest` (which already exists), then rm `src`. */
function mergeInto(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    if (fs.existsSync(to)) continue; // never clobber existing data
    try {
      fs.renameSync(from, to);
    } catch {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  }
  fs.rmSync(src, { recursive: true, force: true });
}

/**
 * Normalize a single app to the split layout. Used after scaffolding an app in
 * the main process and after importing one from a zip.
 */
export function ensureToolDataLayoutForApp(workspaceDir: string, dirName: string): void {
  if (!dirName || dirName.startsWith('_') || dirName === 'install') return;

  const appDir = path.join(workspaceDir, APPLICATIONS_DIR, dirName);
  if (!fs.existsSync(appDir)) return;

  for (const sub of TOOL_DATA_SUBDIRS) {
    const linkPath = path.join(appDir, sub);
    const dataDir = path.join(workspaceDir, TOOL_DATA_DIR, dirName, sub);

    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(linkPath);
    } catch {
      stat = null; // ENOENT
    }

    // Already a symlink — assume it points at the data dir; just ensure the
    // target exists so writes don't fail on a dangling link.
    if (stat?.isSymbolicLink()) {
      fs.mkdirSync(dataDir, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.join(workspaceDir, TOOL_DATA_DIR, dirName), { recursive: true });

    // A real directory left over from the old layout — relocate its contents
    // into the data dir before replacing it with a symlink.
    if (stat?.isDirectory()) {
      if (fs.existsSync(dataDir)) {
        mergeInto(linkPath, dataDir);
      } else {
        try {
          fs.renameSync(linkPath, dataDir);
        } catch {
          fs.cpSync(linkPath, dataDir, { recursive: true });
          fs.rmSync(linkPath, { recursive: true, force: true });
        }
      }
    } else if (stat) {
      // A stray non-dir/non-symlink `input`/`output` file — remove it so the
      // symlink can take its place.
      fs.rmSync(linkPath, { force: true });
    }

    fs.mkdirSync(dataDir, { recursive: true });
    try {
      fs.symlinkSync(symlinkTarget(dirName, sub), linkPath, 'dir');
    } catch (err) {
      log.warn('[ToolData] Failed to create symlink for', linkPath, err);
    }
  }
}

/**
 * Boot-time sweep: apply the split layout to every existing mini-app. Migrates
 * pre-split apps (whose `input`/`output` were real dirs inside the code dir) and
 * is a no-op for apps already migrated.
 */
export function ensureToolDataLayout(workspaceDir: string): void {
  const appsDir = path.join(workspaceDir, APPLICATIONS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appsDir, { withFileTypes: true });
  } catch {
    return; // no .applications yet
  }

  let migrated = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    try {
      ensureToolDataLayoutForApp(workspaceDir, entry.name);
      migrated++;
    } catch (err) {
      log.warn('[ToolData] Failed to normalize layout for', entry.name, err);
    }
  }
  if (migrated > 0) {
    log.info(`[ToolData] Ensured split code/data layout for ${migrated} tool(s).`);
  }
}
