import { app, dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { getAllPodmanDataPaths } from '../podmanBinaries';
import { getDatabase } from '../db/database';
import { getObservationsDatabase } from '../db/observationsDatabase';
import { getSchedulingDatabase } from '../db/schedulingDatabase';
import { getActiveWorkspace, createWorkspace, touchWorkspace } from '../db/workspaceRepository';
import { containerService } from '../containerService';
import { systemLogger } from '../systemLogger';
import { commandLogger } from '../commandLogger';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const crossZip = require('cross-zip');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const extractZip = require('extract-zip');

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

  ipcMain.handle('debug:exportWorkspace', async () => {
    const workspace = getActiveWorkspace();
    if (!workspace) return { ok: false, error: 'No active workspace' };

    const db = getDatabase();
    const wid = workspace.id;

    const sessions = db.prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC').all(wid);
    const sessionIds = (sessions as { id: string }[]).map((s) => s.id);
    const messages = sessionIds.length > 0
      ? db.prepare(`SELECT * FROM messages WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY id`).all(...sessionIds)
      : [];

    const briefings       = db.prepare('SELECT * FROM briefings WHERE workspace_id = ? ORDER BY created_at DESC').all(wid);
    const workspaceReports = db.prepare('SELECT * FROM workspace_reports WHERE workspace_id = ? ORDER BY created_at DESC').all(wid);
    const scannedFiles    = db.prepare('SELECT * FROM scanned_files WHERE workspace_id = ? ORDER BY created_at DESC').all(wid);

    // Calendar — groups must come before events; events before files/deps/resources/reactions
    const groups            = db.prepare('SELECT * FROM groups WHERE workspace_id = ?').all(wid);
    const calendarEvents    = db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ?').all(wid);
    const eventIds          = (calendarEvents as { id: string }[]).map((e) => e.id);
    const groupIds          = (groups as { id: string }[]).map((g) => g.id);

    const eventFiles = eventIds.length > 0
      ? db.prepare(`SELECT * FROM event_files WHERE event_id IN (${eventIds.map(() => '?').join(',')})`).all(...eventIds)
      : [];
    const groupFiles = groupIds.length > 0
      ? db.prepare(`SELECT * FROM group_files WHERE group_id IN (${groupIds.map(() => '?').join(',')})`).all(...groupIds)
      : [];
    const eventDependencies = eventIds.length > 0
      ? db.prepare(`SELECT * FROM event_dependencies WHERE predecessor_id IN (${eventIds.map(() => '?').join(',')})`).all(...eventIds)
      : [];
    const calendarResources = db.prepare('SELECT * FROM calendar_resources WHERE workspace_id = ?').all(wid);
    const calendarReactions = db.prepare('SELECT * FROM calendar_reactions WHERE workspace_id = ?').all(wid);

    // Reactions config from settings file
    const settingsPath = path.join(app.getPath('userData'), 'cobuilding-settings.json');
    let reactions: { prompt: string | null; sources: string[] } = { prompt: null, sources: ['browser', 'file'] };
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      reactions = {
        prompt: data.reactionUserInstructions ?? null,
        sources: data.reactionSources ?? ['browser', 'file'],
      };
    } catch { /* no settings file */ }

    const exportData = {
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      workspace: {
        id: workspace.id,
        name: workspace.name,
        directoryPath: workspace.directory_path,
        createdAt: workspace.created_at,
        updatedAt: workspace.updated_at,
      },
      chats: { sessions, messages },
      briefings,
      workspaceReports,
      scannedFiles,
      calendar: { groups, events: calendarEvents, eventFiles, groupFiles, eventDependencies, resources: calendarResources, reactions: calendarReactions },
      reactions,
    };

    const safeName = workspace.name.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const dateStr = new Date().toISOString().slice(0, 10);
    const zipName = `workspace-export-${safeName}-${dateStr}.zip`;
    const defaultPath = path.join(app.getPath('downloads'), zipName);

    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Export Workspace Data',
      defaultPath,
      filters: [{ name: 'Workspace Export', extensions: ['zip'] }],
    });

    if (canceled || !filePath) return { ok: true, canceled: true };
    const outZip = filePath.endsWith('.zip') ? filePath : `${filePath}.zip`;

    const tmpDir = path.join(os.tmpdir(), `academia-ws-export-${Date.now()}`);
    const contentDir = path.join(tmpDir, 'workspace-export');
    try {
      await fsPromises.mkdir(contentDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(contentDir, 'workspace_data.json'),
        JSON.stringify(exportData, null, 2),
        'utf-8',
      );

      // Copy the entire workspace directory into the bundle
      await fsPromises.cp(
        workspace.directory_path,
        path.join(contentDir, 'workspace_files'),
        { recursive: true },
      );

      await new Promise<void>((resolve, reject) => {
        crossZip.zip(contentDir, outZip, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      log.info('[Debug] Exported workspace to', outZip);
      return { ok: true, savedPath: outZip };
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle('debug:importWorkspace', async () => {
    const openResult = await dialog.showOpenDialog({
      title: 'Import Workspace',
      properties: ['openFile'],
      filters: [{ name: 'Workspace Export', extensions: ['zip'] }],
    });
    if (openResult.canceled || openResult.filePaths.length === 0) return { ok: true, canceled: true };

    const zipPath = openResult.filePaths[0];
    const tmpDir = path.join(os.tmpdir(), `academia-ws-import-${Date.now()}`);

    try {
      await fsPromises.mkdir(tmpDir, { recursive: true });
      await extractZip(zipPath, { dir: tmpDir });

      // Find workspace_data.json — may be at top level or inside a single dir
      let contentDir = tmpDir;
      const topEntries = await fsPromises.readdir(tmpDir, { withFileTypes: true });
      const topDirs = topEntries.filter((e) => e.isDirectory());
      if (topDirs.length === 1 && !topEntries.some((e) => e.name === 'workspace_data.json')) {
        contentDir = path.join(tmpDir, topDirs[0].name);
      }

      type ExportData = {
        workspace?: { name?: string; directoryPath?: string };
        chats?: { sessions?: Record<string, unknown>[]; messages?: Record<string, unknown>[] };
        briefings?: Record<string, unknown>[];
        workspaceReports?: Record<string, unknown>[];
        scannedFiles?: Record<string, unknown>[];
        calendar?: {
          groups?: Record<string, unknown>[];
          events?: Record<string, unknown>[];
          eventFiles?: Record<string, unknown>[];
          groupFiles?: Record<string, unknown>[];
          eventDependencies?: Record<string, unknown>[];
          resources?: Record<string, unknown>[];
          reactions?: Record<string, unknown>[];
        };
        reactions?: { prompt?: string | null; sources?: string[] };
      };
      let exportData: ExportData;
      try {
        exportData = JSON.parse(
          await fsPromises.readFile(path.join(contentDir, 'workspace_data.json'), 'utf-8'),
        );
      } catch {
        return { ok: false, error: 'Invalid workspace export (workspace_data.json not found)' };
      }

      const importedName = exportData.workspace?.name ?? 'Imported Workspace';

      // Place the workspace next to the ZIP file, deduplicating the name if needed
      const zipParentDir = path.dirname(zipPath);
      let dirName = importedName;
      let suffix = 1;
      for (;;) {
        try {
          await fsPromises.stat(path.join(zipParentDir, dirName));
          dirName = `${importedName} ${suffix++}`;
        } catch {
          break;
        }
      }
      const workspaceDir = path.join(zipParentDir, dirName);
      await fsPromises.mkdir(workspaceDir, { recursive: true });

      // Restore workspace files — full copy (current format) with fallback
      // to the old selective format (.applications/ + .academia/ only)
      const workspaceFilesDir = path.join(contentDir, 'workspace_files');
      if (fs.existsSync(workspaceFilesDir)) {
        await fsPromises.cp(workspaceFilesDir, workspaceDir, { recursive: true });
      } else {
        for (const [src, dest] of [['applications', '.applications'], ['academia', '.academia']] as const) {
          const srcDir = path.join(contentDir, src);
          if (fs.existsSync(srcDir)) {
            await fsPromises.cp(srcDir, path.join(workspaceDir, dest), { recursive: true });
          }
        }
      }

      // Create workspace DB record
      const newWorkspaceId = randomUUID();
      createWorkspace(newWorkspaceId, dirName, workspaceDir, '');

      const db = getDatabase();

      // Sort calendar events: parents (recurrence_parent_id = null) before children
      const rawEvents = (exportData.calendar?.events ?? []) as Record<string, unknown>[];
      const sortedEvents = [
        ...rawEvents.filter((e) => e.recurrence_parent_id == null),
        ...rawEvents.filter((e) => e.recurrence_parent_id != null),
      ];

      // Disable FK checking before the transaction — PRAGMA foreign_keys is a
      // no-op inside an open transaction, so it must be set here, outside.
      // All FK constraints in this schema are IMMEDIATE (the SQLite default),
      // so defer_foreign_keys inside the transaction has no effect on them.
      db.pragma('foreign_keys = OFF');
      try {
      db.transaction(() => {

        // Sessions (preserve original UUIDs so message FKs stay valid)
        const insertSession = db.prepare(
          'INSERT OR IGNORE INTO sessions (id, workspace_id, sdk_session_id, title, source, document_path, app_dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const s of exportData.chats?.sessions ?? []) {
          insertSession.run(s.id, newWorkspaceId, s.sdk_session_id ?? null, s.title ?? '', s.source ?? null, s.document_path ?? null, s.app_dir_name ?? null, s.created_at, s.updated_at);
        }

        // Messages — omit id so SQLite auto-assigns, avoiding integer PK collisions
        const insertMessage = db.prepare(
          'INSERT INTO messages (session_id, type, content, created_at) VALUES (?, ?, ?, ?)',
        );
        for (const m of (exportData.chats?.messages ?? []) as Record<string, unknown>[]) {
          insertMessage.run(m.session_id, m.type, m.content, m.created_at);
        }

        // Workspace reports (must precede scanned_files and briefings that reference them)
        const insertReport = db.prepare(
          'INSERT OR IGNORE INTO workspace_reports (id, workspace_id, report_type, report_data, in_depth_report, about_you_summary, what_youre_working_on_summary, what_youre_working_on, suggested_mini_apps, status, error, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const r of (exportData.workspaceReports ?? []) as Record<string, unknown>[]) {
          insertReport.run(r.id, newWorkspaceId, r.report_type ?? 'directory_scan', r.report_data ?? '{}', r.in_depth_report ?? null, r.about_you_summary ?? null, r.what_youre_working_on_summary ?? null, r.what_youre_working_on ?? null, r.suggested_mini_apps ?? null, r.status ?? 'completed', r.error ?? null, r.created_at, r.completed_at ?? null);
        }

        const insertScannedFile = db.prepare(
          'INSERT OR IGNORE INTO scanned_files (id, workspace_id, report_id, file_path, file_name, file_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        for (const sf of (exportData.scannedFiles ?? []) as Record<string, unknown>[]) {
          insertScannedFile.run(sf.id, newWorkspaceId, sf.report_id ?? null, sf.file_path, sf.file_name, sf.file_type, sf.created_at);
        }

        const insertBriefing = db.prepare(
          'INSERT OR IGNORE INTO briefings (id, workspace_id, type, briefing_data, why_im_suggesting_this, status, source_report_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const b of (exportData.briefings ?? []) as Record<string, unknown>[]) {
          insertBriefing.run(randomUUID(), newWorkspaceId, b.type, b.briefing_data, b.why_im_suggesting_this ?? null, b.status, b.source_report_id ?? null, b.created_at, b.updated_at);
        }

        // Calendar: groups → events (parents first) → children
        const insertGroup = db.prepare(
          'INSERT OR IGNORE INTO groups (id, workspace_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const g of (exportData.calendar?.groups ?? []) as Record<string, unknown>[]) {
          insertGroup.run(g.id, newWorkspaceId, g.name, g.color, g.created_at, g.updated_at);
        }

        const insertEvent = db.prepare(
          'INSERT OR IGNORE INTO calendar_events (id, workspace_id, group_id, name, start_at, end_at, status, color, recurrence_rule, recurrence_parent_id, recurrence_exception_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const e of sortedEvents) {
          insertEvent.run(e.id, newWorkspaceId, e.group_id ?? null, e.name, e.start_at, e.end_at, e.status ?? 'active', e.color ?? null, e.recurrence_rule ?? null, e.recurrence_parent_id ?? null, e.recurrence_exception_date ?? null, e.created_at, e.updated_at);
        }

        const insertEventFile = db.prepare('INSERT OR IGNORE INTO event_files (event_id, file_path, created_at) VALUES (?, ?, ?)');
        for (const ef of (exportData.calendar?.eventFiles ?? []) as Record<string, unknown>[]) {
          insertEventFile.run(ef.event_id, ef.file_path, ef.created_at);
        }

        const insertGroupFile = db.prepare('INSERT OR IGNORE INTO group_files (group_id, file_path, created_at) VALUES (?, ?, ?)');
        for (const gf of (exportData.calendar?.groupFiles ?? []) as Record<string, unknown>[]) {
          insertGroupFile.run(gf.group_id, gf.file_path, gf.created_at);
        }

        const insertDep = db.prepare(
          'INSERT OR IGNORE INTO event_dependencies (id, predecessor_id, successor_id, lag_min_ms, lag_max_ms, lag_current_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const d of (exportData.calendar?.eventDependencies ?? []) as Record<string, unknown>[]) {
          insertDep.run(d.id, d.predecessor_id, d.successor_id, d.lag_min_ms ?? 0, d.lag_max_ms ?? null, d.lag_current_ms ?? 0, d.created_at, d.updated_at);
        }

        const insertResource = db.prepare(
          'INSERT OR IGNORE INTO calendar_resources (id, workspace_id, type, event_id, group_id, parent_id, file_path, url, note_content, title, sort_order, ai_generated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const r of (exportData.calendar?.resources ?? []) as Record<string, unknown>[]) {
          insertResource.run(r.id, newWorkspaceId, r.type, r.event_id ?? null, r.group_id ?? null, r.parent_id ?? null, r.file_path ?? null, r.url ?? null, r.note_content ?? null, r.title ?? '', r.sort_order ?? 0, r.ai_generated ?? 0, r.created_at, r.updated_at);
        }

        const insertReaction = db.prepare(
          'INSERT OR IGNORE INTO calendar_reactions (id, workspace_id, event_id, group_id, title, content, status, trigger_context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const r of (exportData.calendar?.reactions ?? []) as Record<string, unknown>[]) {
          insertReaction.run(r.id, newWorkspaceId, r.event_id ?? null, r.group_id ?? null, r.title ?? '', r.content ?? '', r.status ?? 'unread', r.trigger_context ?? '{}', r.created_at, r.updated_at);
        }
      })();
      } finally {
        db.pragma('foreign_keys = ON');
      }

      // Apply reactions settings
      if (exportData.reactions) {
        const settingsPath = path.join(app.getPath('userData'), 'cobuilding-settings.json');
        let settings: Record<string, unknown> = {};
        try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* ok */ }
        if (exportData.reactions.prompt != null) settings.reactionUserInstructions = exportData.reactions.prompt;
        if (exportData.reactions.sources) settings.reactionSources = exportData.reactions.sources;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      }

      // Touch so this workspace sorts as the most-recently-accessed
      touchWorkspace(newWorkspaceId);

      log.info('[Debug] Imported workspace', dirName, 'at', workspaceDir);
      return { ok: true, workspaceName: dirName, workspaceDir, workspaceId: newWorkspaceId };
    } catch (err) {
      log.error('[Debug] Import failed:', err);
      const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
      return { ok: false, error: msg || 'Import failed (no error message)' };
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle('debug:hardResetWorkspace', async () => {
    const workspace = getActiveWorkspace();
    if (!workspace) return { ok: false, error: 'No active workspace' };

    // Remove workspace file directories
    for (const dir of ['.applications', '.academia']) {
      const p = path.join(workspace.directory_path, dir);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }

    // Hard-delete the workspace row — ON DELETE CASCADE removes sessions,
    // messages, briefings, calendar events/resources/reactions, plans,
    // scanned_files, and workspace_reports automatically.
    getDatabase().prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);

    log.warn('[Debug] Hard reset workspace:', workspace.id, workspace.name);
    return { ok: true };
  });
}
