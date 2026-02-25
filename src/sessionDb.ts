import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';

const DB_NAME = app.isPackaged ? 'sessions.db' : 'sessions-dev.db';
const dbPath = path.join(app.getPath('userData'), DB_NAME);
const db = new Database(dbPath);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_type TEXT NOT NULL,
    user_id INTEGER,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
  )
`);

const insertSession = db.prepare(
  `INSERT INTO sessions (session_id, session_type, user_id, start_time, end_time, data)
   VALUES (?, ?, ?, ?, ?, ?)`
);

const updateEndTime = db.prepare(
  `UPDATE sessions SET end_time = ? WHERE session_id = ?`
);

const setUserId = db.prepare(
  `UPDATE sessions SET user_id = ? WHERE session_id = ?`
);

export { db, insertSession, updateEndTime, setUserId };
