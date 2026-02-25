import Database from 'better-sqlite3';

export interface SessionDb {
  db: Database.Database;
  insertSession: Database.Statement;
  updateEndTime: Database.Statement;
  setUserId: Database.Statement;
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
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);

  // Migration for existing databases: add new columns if missing
  for (const col of ['device_id', 'created_at', 'updated_at']) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
  }

  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, session_type, user_id, start_time, end_time, data, device_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const updateEndTime = db.prepare(
    `UPDATE sessions SET end_time = ?, updated_at = ? WHERE session_id = ?`
  );

  const setUserId = db.prepare(
    `UPDATE sessions SET user_id = ?, updated_at = ? WHERE session_id = ?`
  );

  return { db, insertSession, updateEndTime, setUserId };
}
