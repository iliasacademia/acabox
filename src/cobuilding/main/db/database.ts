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
    version: 5,
    sql: `
      CREATE TABLE writing_projects (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        file_count INTEGER DEFAULT 0,
        primary_manuscript_id INTEGER,
        server_created_at TEXT NOT NULL,
        server_updated_at TEXT NOT NULL,
        synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE TABLE writing_project_files (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        file_type TEXT DEFAULT 'other',
        rel_path TEXT,
        is_primary_manuscript INTEGER DEFAULT 0,
        size INTEGER DEFAULT 0,
        tag TEXT,
        server_created_at TEXT NOT NULL,
        server_updated_at TEXT NOT NULL
      );

      CREATE TABLE writing_supporting_files (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        file_type TEXT DEFAULT 'other',
        rel_path TEXT,
        size INTEGER DEFAULT 0,
        tag TEXT,
        summary TEXT,
        server_created_at TEXT NOT NULL,
        server_updated_at TEXT NOT NULL
      );

      CREATE TABLE writing_conversations (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        server_created_at TEXT NOT NULL,
        server_updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_writing_projects_workspace ON writing_projects(workspace_id);
      CREATE INDEX idx_writing_files_project ON writing_project_files(project_id);
      CREATE INDEX idx_writing_supporting_workspace ON writing_supporting_files(workspace_id);
      CREATE INDEX idx_writing_convos_project ON writing_conversations(project_id);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE writing_conversation_messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES writing_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        format TEXT,
        server_created_at TEXT NOT NULL
      );

      CREATE INDEX idx_writing_messages_convo ON writing_conversation_messages(conversation_id);
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
