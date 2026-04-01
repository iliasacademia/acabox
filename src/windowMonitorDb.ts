import Database, { Statement } from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import { getChannelFromVersion } from './utils/config/loggingConfig';

function getDbName(): string {
  if (!app.isPackaged) return 'window-monitor-dev.db';
  return `window-monitor-${getChannelFromVersion()}.db`;
}

let db: InstanceType<typeof Database> | null = null;
let insertStmt: Statement | null = null;
let appVersion: string = '';
let initFailed = false;

function ensureInitialized(): boolean {
  if (db) return true;
  if (initFailed) return false;
  try {
    const dbPath = path.join(app.getPath('userData'), getDbName());
    db = new Database(dbPath);

    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS window_monitor_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        app_version TEXT NOT NULL,
        data_type TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `);

    insertStmt = db.prepare(
      `INSERT INTO window_monitor_log (timestamp, app_version, data_type, data) VALUES (?, ?, ?, ?)`
    );

    appVersion = app.getVersion();
    return true;
  } catch {
    initFailed = true;
    return false;
  }
}

export type WindowMonitorLogDataType = 'window_monitor_event' | 'window_monitor_state' | 'webview_manager_state' | 'word_poll_event' | 'word_actions_request' | 'word_actions_response';

export function logToWindowMonitorDb(dataType: WindowMonitorLogDataType, data: unknown): void {
  if (!ensureInitialized()) return;
  insertStmt!.run(new Date().toISOString(), appVersion, dataType, JSON.stringify(data));
}
