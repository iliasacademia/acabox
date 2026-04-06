import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';
const appVersion = app.getVersion();
import { createFileSession, updateFileSession, findFileSession } from './repository';

interface FileMonitorEvent {
  event: 'APP_FOCUSED' | 'APP_UNFOCUSED' | 'WINDOW_FOCUSED' | 'FILE_MONITOR_POLL';
  timestamp: string;
  platform: string;
  app: {
    name: string;
    bundleId: string;
    pid: number;
  };
  window: {
    id: number | null;
    title: string | null;
    documentUrl: string | null;
  };
}

let childProcess: ChildProcess | null = null;

function getBinaryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'file-monitor-mac');
  }
  return path.join(app.getAppPath(), 'cobuilding/rust/file-monitor-mac/target/debug/file-monitor-mac');
}

function getLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function handleEvent(event: FileMonitorEvent): void {
  if (event.event === 'APP_UNFOCUSED') return;

  const documentUrl = event.window.documentUrl;
  if (!documentUrl) return;

  const sessionDate = getLocalDate();
  const timestamp = event.timestamp;
  const existing = findFileSession(documentUrl, sessionDate);

  if (existing) {
    updateFileSession(existing.id!, timestamp, event.window.title);
  } else {
    createFileSession({
      document_url: documentUrl,
      app_name: event.app.name,
      app_bundle_id: event.app.bundleId,
      window_title: event.window.title,
      session_date: sessionDate,
      first_seen: timestamp,
      last_seen: timestamp,
      poll_count: 1,
      app_version: appVersion,
    });
    log.info('[FileMonitor] New file session:', documentUrl, sessionDate);
  }
}

export function startFileMonitor(): void {
  if (childProcess) {
    log.warn('[FileMonitor] Already running');
    return;
  }

  const binPath = getBinaryPath();
  log.info('[FileMonitor] Starting:', binPath);

  childProcess = spawn(binPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });

  const rl = createInterface({ input: childProcess.stdout! });
  rl.on('line', (line) => {
    try {
      const event = JSON.parse(line) as FileMonitorEvent;
      handleEvent(event);
    } catch (err) {
      log.warn('[FileMonitor] Failed to parse event:', line);
    }
  });

  childProcess.stderr?.on('data', (data: Buffer) => {
    log.warn('[FileMonitor] stderr:', data.toString().trim());
  });

  childProcess.on('error', (err) => {
    log.error('[FileMonitor] Process error:', err);
    childProcess = null;
  });

  childProcess.on('exit', (code, signal) => {
    log.info('[FileMonitor] Process exited:', { code, signal });
    childProcess = null;
  });
}

export function stopFileMonitor(): void {
  if (!childProcess) return;
  log.info('[FileMonitor] Stopping');
  childProcess.kill('SIGTERM');
  childProcess = null;
}

export function isFileMonitorRunning(): boolean {
  return childProcess !== null;
}
