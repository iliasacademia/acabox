import Database from 'better-sqlite3';
import path from 'path';
import log from 'electron-log';

let db: Database.Database | null = null;

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE browser_sessions (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        referrer TEXT NOT NULL DEFAULT '',
        meta_tags TEXT NOT NULL DEFAULT '{}',
        full_text TEXT,
        text_hash TEXT NOT NULL DEFAULT '',
        first_seen TEXT NOT NULL,
        last_snapshot TEXT NOT NULL,
        total_dwell REAL NOT NULL DEFAULT 0,
        max_scroll_depth REAL NOT NULL DEFAULT 0,
        selections TEXT NOT NULL DEFAULT '[]',
        snapshot_count INTEGER NOT NULL DEFAULT 1,
        triage_state TEXT NOT NULL DEFAULT 'pending',
        app_version TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE file_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_url TEXT NOT NULL,
        app_name TEXT NOT NULL,
        app_bundle_id TEXT NOT NULL,
        window_title TEXT,
        session_date TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        poll_count INTEGER NOT NULL DEFAULT 1,
        app_version TEXT NOT NULL DEFAULT '',
        snapshot_ulid TEXT
      );
      CREATE UNIQUE INDEX idx_file_sessions_url_date ON file_sessions(document_url, session_date);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE browser_sessions RENAME TO browser_sessions_v1;

      CREATE TABLE browser_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        referrer TEXT NOT NULL DEFAULT '',
        meta_tags TEXT NOT NULL DEFAULT '{}',
        full_text TEXT,
        text_hash TEXT NOT NULL DEFAULT '',
        first_seen TEXT NOT NULL,
        last_snapshot TEXT NOT NULL,
        total_dwell REAL NOT NULL DEFAULT 0,
        max_scroll_depth REAL NOT NULL DEFAULT 0,
        selections TEXT NOT NULL DEFAULT '[]',
        snapshot_count INTEGER NOT NULL DEFAULT 1,
        triage_state TEXT NOT NULL DEFAULT 'pending',
        app_version TEXT NOT NULL DEFAULT '',
        session_date TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_browser_sessions_url_date ON browser_sessions(url, session_date);

      INSERT INTO browser_sessions (url, title, referrer, meta_tags, full_text, text_hash,
        first_seen, last_snapshot, total_dwell, max_scroll_depth, selections, snapshot_count,
        triage_state, app_version, session_date)
      SELECT url, title, referrer, meta_tags, full_text, text_hash,
        first_seen, last_snapshot, total_dwell, max_scroll_depth, selections, snapshot_count,
        triage_state, app_version, date(first_seen)
      FROM browser_sessions_v1;

      DROP TABLE browser_sessions_v1;
    `,
  },
  {
    version: 3,
    sql: `ALTER TABLE file_sessions ADD COLUMN total_dwell REAL NOT NULL DEFAULT 0;`,
  },
];

function runMigrations(database: Database.Database) {
  const currentVersion = database.pragma('user_version', {
    simple: true,
  }) as number;

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      database.transaction(() => {
        database.exec(migration.sql);
        database.pragma(`user_version = ${migration.version}`);
      })();
    }
  }
}

export function initObservationsDatabase(userDataPath: string): Database.Database {
  if (db) return db;

  const dbPath = path.join(userDataPath, 'observations.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');

  runMigrations(db);

  log.info('[DB] Observations database initialized at', dbPath);
  return db;
}

export function getObservationsDatabase(): Database.Database {
  if (!db) throw new Error('Observations database not initialized. Call initObservationsDatabase first.');
  return db;
}

export function closeObservationsDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
