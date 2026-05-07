import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import { getAllPodmanDataPaths } from '../podmanBinaries';
import { getDatabase } from '../db/database';
import { getObservationsDatabase } from '../db/observationsDatabase';
import { getSchedulingDatabase } from '../db/schedulingDatabase';
import { containerService } from '../containerService';
import { systemLogger } from '../systemLogger';
import { commandLogger } from '../commandLogger';

function removePath(p: string): { path: string; ok: boolean; error?: string } {
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      return { path: p, ok: true };
    }
    return { path: p, ok: true };
  } catch (err) {
    return { path: p, ok: false, error: (err as Error).message };
  }
}

export function registerDebugHandlers() {
  ipcMain.handle('debug:getStorageInfo', () => {
    const userData = app.getPath('userData');
    const podmanPaths = getAllPodmanDataPaths();
    return {
      environment: app.isPackaged ? 'production' : 'development',
      userData,
      podmanPaths,
    };
  });

  // Renderer → main bridge for diagnostic logs. The desktop chat panel
  // and other renderers can pipe a string into electron-log so it
  // lands in the same on-disk file as main-process logs and can be
  // tailed from a shell — useful when the surface in question (e.g.
  // the Word overlay) doesn't expose devtools.
  ipcMain.handle('debug:log', (_event: unknown, msg: string) => {
    log.info(typeof msg === 'string' ? msg : String(msg));
  });

  ipcMain.handle('debug:clearSelected', async (_event: unknown, ids: string[]) => {
    const set = new Set(ids);
    const results: string[] = [];
    const errors: string[] = [];
    const userData = app.getPath('userData');

    const ok = (label: string) => results.push(label);
    const fail = (label: string, err: string) => errors.push(`${label}: ${err}`);

    // ── Chat Sessions & Messages ──
    if (set.has('chat-sessions')) {
      try {
        const db = getDatabase();
        db.exec('DELETE FROM messages');
        db.exec('DELETE FROM sessions');
        ok('Chat sessions');
      } catch (e) { fail('Chat sessions', (e as Error).message); }
    }

    // ── Workspace Records ──
    if (set.has('workspace-records')) {
      try {
        const db = getDatabase();
        const workspaces = db.prepare('SELECT directory_path FROM workspaces').all() as { directory_path: string }[];
        // Remove .academia and .claude dirs inside each workspace
        for (const w of workspaces) {
          for (const sub of ['.academia', '.claude']) {
            const p = path.join(w.directory_path, sub);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
          }
        }
        db.exec('DELETE FROM messages');
        db.exec('DELETE FROM sessions');
        db.exec('DELETE FROM workspaces');
        ok('Workspaces');
      } catch (e) { fail('Workspaces', (e as Error).message); }
    }

    // ── Browser Activity ──
    if (set.has('browser-activity')) {
      try {
        const db = getObservationsDatabase();
        db.exec("DELETE FROM session_files WHERE session_type = 'browser'");
        db.exec('DELETE FROM browser_sessions');
        ok('Browser activity');
      } catch (e) { fail('Browser activity', (e as Error).message); }
    }

    // ── File Activity ──
    if (set.has('file-activity')) {
      try {
        const db = getObservationsDatabase();
        db.exec("DELETE FROM session_files WHERE session_type = 'file'");
        db.exec('DELETE FROM file_sessions');
        ok('File activity');
      } catch (e) { fail('File activity', (e as Error).message); }
    }

    // ── Scheduled Tasks ──
    if (set.has('scheduled-tasks')) {
      try {
        const db = getSchedulingDatabase();
        db.exec('DELETE FROM scheduled_task_runs');
        db.exec('DELETE FROM scheduled_tasks');
        ok('Scheduled tasks');
      } catch (e) { fail('Scheduled tasks', (e as Error).message); }
    }

    // ── Task Run History ──
    if (set.has('task-runs')) {
      try {
        const db = getSchedulingDatabase();
        db.exec('DELETE FROM scheduled_task_runs');
        ok('Task run history');
      } catch (e) { fail('Task run history', (e as Error).message); }
    }

    // ── System Log ──
    if (set.has('system-log')) {
      try { systemLogger.clear(); ok('System log'); }
      catch (e) { fail('System log', (e as Error).message); }
    }

    // ── Command Log ──
    if (set.has('command-log')) {
      try { commandLogger.clear(); ok('Command log'); }
      catch (e) { fail('Command log', (e as Error).message); }
    }

    // ── App Log ──
    if (set.has('app-log')) {
      const logPath = path.join(userData, 'cobuilding.log');
      const r = removePath(logPath);
      r.ok ? ok('App log') : fail('App log', r.error!);
    }

    // ── Settings ──
    if (set.has('settings')) {
      const r = removePath(path.join(userData, 'cobuilding-settings.json'));
      r.ok ? ok('Settings') : fail('Settings', r.error!);
    }

    // ── Podman Binaries ──
    if (set.has('podman-binaries')) {
      try {
        containerService.deleteBundledBinaries();
        ok('Podman binaries');
      } catch (e) { fail('Podman binaries', (e as Error).message); }
    }

    // ── Podman Config & VM Images ──
    if (set.has('podman-config-data')) {
      const r = removePath(path.join(userData, 'cobuilding-podman-data'));
      r.ok ? ok('Podman config & data') : fail('Podman config & data', r.error!);
    }

    // ── Container Image ──
    if (set.has('container-image')) {
      try {
        await containerService.deleteImage();
        ok('Container image');
      } catch (e) { fail('Container image', (e as Error).message); }
    }

    // ── Podman VM State ──
    if (set.has('podman-vm')) {
      try { containerService.stop(); } catch { /* ok */ }
      const podmanPaths = getAllPodmanDataPaths();
      for (const p of podmanPaths) {
        if (p.label.includes('HOME') || p.label.includes('runtime')) {
          const r = removePath(p.path);
          if (!r.ok) fail(p.label, r.error!);
        }
      }
      ok('Podman VM state');
    }

    // ── Electron Cache ──
    if (set.has('electron-cache')) {
      for (const dir of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
        'Local Storage', 'Session Storage', 'blob_storage', 'SharedStorage']) {
        removePath(path.join(userData, dir));
      }
      ok('Electron cache');
    }

    log.warn('[Debug] clearSelected:', { cleared: results, errors });
    return { cleared: results, errors };
  });
}
