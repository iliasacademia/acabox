import Database from 'better-sqlite3';
import path from 'path';
import log from 'electron-log';

let db: Database.Database | null = null;

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        cron_expression TEXT NOT NULL DEFAULT '0 */2 * * *',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );

      CREATE TABLE scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        completed_at TEXT,
        error TEXT
      );

      CREATE INDEX idx_scheduled_tasks_workspace ON scheduled_tasks(workspace_id);
      CREATE INDEX idx_task_runs_task ON scheduled_task_runs(task_id);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE scheduled_tasks ADD COLUMN session_source TEXT DEFAULT NULL;
      UPDATE scheduled_tasks SET session_source = 'reactions' WHERE name = 'Activity Summary';
    `,
  },
  {
    version: 3,
    sql: `
      UPDATE scheduled_tasks SET cron_expression = '0 */2 * * *' WHERE name = 'Activity Summary' AND cron_expression = '0 * * * *';
    `,
  },
  {
    version: 4,
    sql: `UPDATE scheduled_tasks SET session_source = 'reactions-system' WHERE session_source = 'reactions';`,
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

export function initSchedulingDatabase(userDataPath: string): Database.Database {
  if (db) return db;

  const dbPath = path.join(userDataPath, 'scheduling.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  log.info('[DB] Scheduling database initialized at', dbPath);
  return db;
}

export function getSchedulingDatabase(): Database.Database {
  if (!db) throw new Error('Scheduling database not initialized. Call initSchedulingDatabase first.');
  return db;
}

export function closeSchedulingDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
