import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import { getChannelFromVersion } from './utils/config/loggingConfig';

function getDbName(): string {
  if (!app.isPackaged) return 'window-monitor-dev.db';
  return `window-monitor-${getChannelFromVersion()}.db`;
}

const dbPath = path.join(app.getPath('userData'), getDbName());
const db = new Database(dbPath);

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

const insertStmt = db.prepare(
  `INSERT INTO window_monitor_log (timestamp, app_version, data_type, data) VALUES (?, ?, ?, ?)`
);

const appVersion = app.getVersion();

export type WindowMonitorLogDataType = 'window_monitor_event' | 'window_monitor_state' | 'webview_manager_state';

export function logToWindowMonitorDb(dataType: WindowMonitorLogDataType, data: unknown): void {
  insertStmt.run(new Date().toISOString(), appVersion, dataType, JSON.stringify(data));
}
