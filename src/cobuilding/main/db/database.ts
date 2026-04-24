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
    sql: `ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT NULL;`,
  },
  {
    version: 3,
    sql: `UPDATE sessions SET source = 'reactions-system' WHERE source = 'reactions';`,
  },
  {
    version: 4,
    sql: `ALTER TABLE workspaces ADD COLUMN last_accessed_at TEXT DEFAULT NULL;`,
  },
  {
    // Migration 5 originally created writing_* tables. Now a no-op for fresh
    // databases; migration 7 drops these tables for existing databases.
    version: 5,
    sql: `SELECT 1;`,
  },
  {
    // Migration 6 originally created writing_conversation_messages. Now a no-op.
    version: 6,
    sql: `SELECT 1;`,
  },
  {
    version: 7,
    sql: `
      DROP TABLE IF EXISTS writing_conversation_messages;
      DROP TABLE IF EXISTS writing_conversations;
      DROP TABLE IF EXISTS writing_project_files;
      DROP TABLE IF EXISTS writing_supporting_files;
      DROP TABLE IF EXISTS writing_projects;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      CREATE INDEX idx_plans_workspace ON plans(workspace_id);

      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'inactive', 'inactive_hidden')),
        color TEXT,
        recurrence_rule TEXT,
        recurrence_parent_id TEXT REFERENCES calendar_events(id) ON DELETE CASCADE,
        recurrence_exception_date TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      CREATE INDEX idx_calendar_events_workspace ON calendar_events(workspace_id);
      CREATE INDEX idx_calendar_events_plan ON calendar_events(plan_id);
      CREATE INDEX idx_calendar_events_time ON calendar_events(workspace_id, start_at, end_at);

      CREATE TABLE event_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      CREATE INDEX idx_event_files_event ON event_files(event_id);

      CREATE TABLE plan_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      CREATE INDEX idx_plan_files_plan ON plan_files(plan_id);
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
