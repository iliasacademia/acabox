import Database from 'better-sqlite3';

export interface SessionDb {
  db: Database.Database;
  insertSession: Database.Statement;
  updateEndTime: Database.Statement;
  updateSessionData: Database.Statement;
  setUserId: Database.Statement;
  getUnsyncedSessions: Database.Statement;
  markSynced: Database.Statement;
  deleteOldSessions: Database.Statement;
  getMetadata: Database.Statement;
  setMetadata: Database.Statement;
}

export function createSessionDb(db: Database.Database): SessionDb {
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      session_type TEXT NOT NULL,
      user_id INTEGER,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      device_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      synced_at TEXT DEFAULT NULL,
      app_version TEXT NOT NULL DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Migration for existing databases: add new columns if missing
  try { db.exec('ALTER TABLE sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT ""'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT ""'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE sessions ADD COLUMN updated_at TEXT NOT NULL DEFAULT ""'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE sessions ADD COLUMN synced_at TEXT DEFAULT NULL'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE sessions ADD COLUMN app_version TEXT NOT NULL DEFAULT ""'); } catch { /* already exists */ }

  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, session_type, user_id, start_time, end_time, data, device_id, created_at, updated_at, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const updateEndTime = db.prepare(
    `UPDATE sessions SET end_time = ?, updated_at = ? WHERE session_id = ?`
  );

  const updateSessionData = db.prepare(
    `UPDATE sessions SET data = ?, updated_at = ? WHERE session_id = ?`
  );

  const setUserId = db.prepare(
    `UPDATE sessions SET user_id = ?, updated_at = ? WHERE session_id = ?`
  );

  const getUnsyncedSessions = db.prepare(
    `SELECT * FROM sessions WHERE user_id IS NOT NULL AND (synced_at IS NULL OR updated_at > synced_at)`
  );

  const markSynced = db.prepare(
    `UPDATE sessions SET synced_at = ? WHERE session_id = ?`
  );

  const deleteOldSessions = db.prepare(
    `DELETE FROM sessions WHERE end_time < ?`
  );

  const getMetadata = db.prepare(
    `SELECT value FROM session_metadata WHERE key = ?`
  );

  const setMetadata = db.prepare(
    `INSERT OR REPLACE INTO session_metadata (key, value) VALUES (?, ?)`
  );

  return { db, insertSession, updateEndTime, updateSessionData, setUserId, getUnsyncedSessions, markSynced, deleteOldSessions, getMetadata, setMetadata };
}
