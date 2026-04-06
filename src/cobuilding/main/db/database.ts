import Database from 'better-sqlite3';
import path from 'path';
import log from 'electron-log';

let db: Database.Database | null = null;

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        directory_path TEXT NOT NULL,
        api_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        sdk_session_id TEXT,
        title TEXT NOT NULL DEFAULT 'New Chat',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE INDEX idx_messages_session_id ON messages(session_id, id);
    `,
  },
  {
    version: 2,
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
        triage_state TEXT NOT NULL DEFAULT 'pending'
      );
    `,
  },
  {
    version: 3,
    sql: `
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

export function initDatabase(userDataPath: string): Database.Database {
  if (db) return db;

  const dbPath = path.join(userDataPath, 'cobuilding.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  log.info('[DB] Cobuilding database initialized at', dbPath);
  return db;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase first.');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
