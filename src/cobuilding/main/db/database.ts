import Database from 'better-sqlite3';
import * as fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { WORKSPACE_DATA_DIR, ACADEMIA_DIR, APPLICATIONS_DIR, CLAUDE_DIR, SOUL_MD, FOCUS_MD } from '../../shared/paths';

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
  {
    version: 9,
    sql: `
      CREATE TABLE event_dependencies (
        id              TEXT PRIMARY KEY,
        predecessor_id  TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
        successor_id    TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
        lag_min_ms      INTEGER NOT NULL DEFAULT 0,
        lag_max_ms      INTEGER,
        lag_current_ms  INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        UNIQUE(predecessor_id, successor_id),
        CHECK(lag_min_ms >= 0),
        CHECK(lag_max_ms IS NULL OR lag_max_ms >= lag_min_ms),
        CHECK(lag_current_ms >= lag_min_ms)
      );
      CREATE INDEX idx_event_deps_predecessor ON event_dependencies(predecessor_id);
      CREATE INDEX idx_event_deps_successor   ON event_dependencies(successor_id);
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE calendar_resources (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type         TEXT NOT NULL CHECK (type IN ('file', 'link', 'note')),
        event_id     TEXT REFERENCES calendar_events(id) ON DELETE CASCADE,
        plan_id      TEXT REFERENCES plans(id) ON DELETE CASCADE,
        file_path    TEXT,
        url          TEXT,
        note_content TEXT,
        title        TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        CHECK (
          (type = 'file' AND file_path IS NOT NULL AND url IS NULL          AND note_content IS NULL) OR
          (type = 'link' AND url IS NOT NULL        AND file_path IS NULL   AND note_content IS NULL) OR
          (type = 'note' AND note_content IS NOT NULL AND file_path IS NULL AND url IS NULL)
        ),
        CHECK (event_id IS NULL OR plan_id IS NULL)
      );
      CREATE INDEX idx_calendar_resources_workspace ON calendar_resources(workspace_id);
      CREATE INDEX idx_calendar_resources_event     ON calendar_resources(event_id);
      CREATE INDEX idx_calendar_resources_plan      ON calendar_resources(plan_id);
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE calendar_reactions (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        event_id        TEXT REFERENCES calendar_events(id) ON DELETE SET NULL,
        plan_id         TEXT REFERENCES plans(id) ON DELETE SET NULL,
        title           TEXT NOT NULL DEFAULT '',
        content         TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'unread'
          CHECK (status IN ('unread', 'read', 'dismissed')),
        trigger_context TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      CREATE INDEX idx_calendar_reactions_workspace ON calendar_reactions(workspace_id);
      CREATE INDEX idx_calendar_reactions_event     ON calendar_reactions(event_id);
      CREATE INDEX idx_calendar_reactions_status    ON calendar_reactions(workspace_id, status);

      ALTER TABLE calendar_resources ADD COLUMN ai_generated INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 12,
    sql: `
      CREATE TABLE calendar_resources_v12 (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type         TEXT NOT NULL CHECK (type IN ('file', 'link', 'note', 'folder')),
        event_id     TEXT REFERENCES calendar_events(id) ON DELETE CASCADE,
        plan_id      TEXT REFERENCES plans(id) ON DELETE CASCADE,
        parent_id    TEXT,
        file_path    TEXT,
        url          TEXT,
        note_content TEXT,
        title        TEXT NOT NULL DEFAULT '',
        sort_order   INTEGER NOT NULL DEFAULT 0,
        ai_generated INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        CHECK (
          (type = 'file'   AND file_path IS NOT NULL AND url IS NULL          AND note_content IS NULL) OR
          (type = 'link'   AND url IS NOT NULL        AND file_path IS NULL   AND note_content IS NULL) OR
          (type = 'note'   AND note_content IS NOT NULL AND file_path IS NULL AND url IS NULL) OR
          (type = 'folder' AND file_path IS NULL      AND url IS NULL         AND note_content IS NULL)
        ),
        CHECK (event_id IS NULL OR plan_id IS NULL)
      );
      INSERT INTO calendar_resources_v12
        (id, workspace_id, type, event_id, plan_id, file_path, url, note_content, title, ai_generated, created_at, updated_at)
        SELECT id, workspace_id, type, event_id, plan_id, file_path, url, note_content, title, ai_generated, created_at, updated_at
        FROM calendar_resources;
      DROP TABLE calendar_resources;
      ALTER TABLE calendar_resources_v12 RENAME TO calendar_resources;
      CREATE INDEX idx_calendar_resources_workspace ON calendar_resources(workspace_id);
      CREATE INDEX idx_calendar_resources_event     ON calendar_resources(event_id);
      CREATE INDEX idx_calendar_resources_plan      ON calendar_resources(plan_id);
      CREATE INDEX idx_calendar_resources_parent    ON calendar_resources(parent_id);
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE plans RENAME TO groups;
      ALTER TABLE plan_files RENAME TO group_files;
      ALTER TABLE calendar_events RENAME COLUMN plan_id TO group_id;
      ALTER TABLE calendar_resources RENAME COLUMN plan_id TO group_id;
      ALTER TABLE calendar_reactions RENAME COLUMN plan_id TO group_id;
      ALTER TABLE group_files RENAME COLUMN plan_id TO group_id;
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE sessions ADD COLUMN document_path TEXT DEFAULT NULL;
      CREATE INDEX idx_sessions_document_path ON sessions(workspace_id, document_path);
    `,
  },
  {
    version: 15,
    sql: `
      ALTER TABLE sessions ADD COLUMN app_dir_name TEXT DEFAULT NULL;
      CREATE INDEX idx_sessions_app_dir ON sessions(workspace_id, app_dir_name);
    `,
  },
  {
    version: 16,
    sql: `
      CREATE TABLE workspace_reports (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        report_type TEXT NOT NULL DEFAULT 'directory_scan',
        report_data TEXT NOT NULL DEFAULT '{}',
        in_depth_report TEXT,
        about_you_summary TEXT,
        what_youre_working_on_summary TEXT,
        what_youre_working_on TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        completed_at TEXT
      );
      CREATE INDEX idx_workspace_reports_workspace ON workspace_reports(workspace_id);
    `,
  },
  {
    version: 17,
    sql: `
      ALTER TABLE workspace_reports ADD COLUMN suggested_mini_apps TEXT;
    `,
  },
  {
    version: 18,
    sql: `
      CREATE TABLE briefings (
        id                     TEXT PRIMARY KEY,
        workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type                   TEXT NOT NULL
          CHECK (type IN ('suggested_action', 'suggested_tool', 'paper', 'citation', 'grant', 'writing_agent')),
        briefing_data          TEXT NOT NULL DEFAULT '{}',
        why_im_suggesting_this TEXT,
        status                 TEXT NOT NULL DEFAULT 'new'
          CHECK (status IN ('new', 'opened', 'dismissed')),
        source_report_id       TEXT REFERENCES workspace_reports(id) ON DELETE SET NULL,
        created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      CREATE INDEX idx_briefings_workspace_created ON briefings(workspace_id, created_at DESC);
      CREATE INDEX idx_briefings_workspace_status  ON briefings(workspace_id, status);
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE scanned_files (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        report_id TEXT REFERENCES workspace_reports(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL CHECK (file_type IN ('manuscript', 'grant', 'presentation')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      CREATE INDEX idx_scanned_files_workspace ON scanned_files(workspace_id);
      CREATE INDEX idx_scanned_files_type ON scanned_files(workspace_id, file_type);
    `,
  },
  {
    // Existing dev installs ran v18 before 'writing_agent' was added to the
    // CHECK clause. SQLite has no ALTER for CHECK constraints, so we recreate
    // the briefings table preserving rows.
    version: 20,
    sql: `
      CREATE TABLE briefings_new (
        id                     TEXT PRIMARY KEY,
        workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type                   TEXT NOT NULL
          CHECK (type IN ('suggested_action', 'suggested_tool', 'paper', 'citation', 'grant', 'writing_agent')),
        briefing_data          TEXT NOT NULL DEFAULT '{}',
        why_im_suggesting_this TEXT,
        status                 TEXT NOT NULL DEFAULT 'new'
          CHECK (status IN ('new', 'opened', 'dismissed')),
        source_report_id       TEXT REFERENCES workspace_reports(id) ON DELETE SET NULL,
        created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      INSERT INTO briefings_new
        SELECT id, workspace_id, type, briefing_data, why_im_suggesting_this,
               status, source_report_id, created_at, updated_at
        FROM briefings;
      DROP TABLE briefings;
      ALTER TABLE briefings_new RENAME TO briefings;
      CREATE INDEX idx_briefings_workspace_created ON briefings(workspace_id, created_at DESC);
      CREATE INDEX idx_briefings_workspace_status  ON briefings(workspace_id, status);
    `,
  },
  {
    version: 21,
    sql: `ALTER TABLE workspaces ADD COLUMN deleted_at TEXT DEFAULT NULL;`,
  },
  {
    version: 22,
    sql: `
      CREATE TABLE scanned_files_v22 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        report_id TEXT REFERENCES workspace_reports(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL CHECK (file_type IN ('manuscript', 'grant', 'presentation', 'reference')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
      );
      INSERT INTO scanned_files_v22
        SELECT id, workspace_id, report_id, file_path, file_name, file_type, created_at
        FROM scanned_files;
      DROP TABLE scanned_files;
      ALTER TABLE scanned_files_v22 RENAME TO scanned_files;
      CREATE INDEX idx_scanned_files_workspace ON scanned_files(workspace_id);
      CREATE INDEX idx_scanned_files_type ON scanned_files(workspace_id, file_type);
    `,
  },
  {
    // messageId end-to-end: a renderer-generated UUID that correlates a turn
    // across renderer → main → agent-server → SSE events → DB. Nullable so
    // historical rows pre-column remain untouched.
    version: 23,
    sql: `
      ALTER TABLE messages ADD COLUMN message_id TEXT DEFAULT NULL;
      CREATE INDEX idx_messages_message_id ON messages(message_id) WHERE message_id IS NOT NULL;
    `,
  },
  {
    version: 24,
    fn: (database: Database.Database, userDataPath: string) => {
      database.exec(`
        CREATE TABLE workspace_directories (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          directory_path TEXT NOT NULL,
          display_name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
        );
        CREATE INDEX idx_workspace_dirs_workspace ON workspace_directories(workspace_id);
        CREATE UNIQUE INDEX idx_workspace_dirs_unique_path ON workspace_directories(workspace_id, directory_path);
      `);

      const row = database.prepare(
        "SELECT id, directory_path FROM workspaces WHERE directory_path != '' AND deleted_at IS NULL ORDER BY last_accessed_at DESC, created_at ASC LIMIT 1",
      ).get() as { id: string; directory_path: string } | undefined;

      database.exec("UPDATE workspaces SET directory_path = '', name = '';");

      if (!row) return;

      const basename = row.directory_path.split('/').pop() || row.directory_path;
      database.prepare(
        'INSERT INTO workspace_directories (id, workspace_id, directory_path, display_name, sort_order) VALUES (?, ?, ?, ?, 0)',
      ).run(randomUUID(), row.id, row.directory_path, basename);

      // Copy agent-controlled files from user directory to workspace-data
      const userDir = row.directory_path;
      if (!fs.existsSync(userDir)) return;

      const agentDir = path.join(userDataPath, WORKSPACE_DATA_DIR);
      fs.mkdirSync(agentDir, { recursive: true });

      for (const name of [ACADEMIA_DIR, APPLICATIONS_DIR, CLAUDE_DIR, SOUL_MD, FOCUS_MD]) {
        const src = path.join(userDir, name);
        if (!fs.existsSync(src)) continue;
        try {
          fs.cpSync(src, path.join(agentDir, name), { recursive: true });
        } catch (err) {
          log.warn(`[Migration 24] Failed to copy ${src}:`, err);
        }
      }
    },
  },
  {
    version: 25,
    sql: `
      ALTER TABLE briefings ADD COLUMN sort_order INTEGER;
    `,
  },
  {
    version: 26,
    sql: `
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        read_at TEXT
      );
      CREATE INDEX idx_notifications_workspace_unread ON notifications(workspace_id, read_at);
    `,
  },
];

function runMigrations(database: Database.Database, userDataPath: string) {
  const currentVersion = database.pragma('user_version', {
    simple: true,
  }) as number;

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      database.transaction(() => {
        if ('fn' in migration && migration.fn) {
          migration.fn(database, userDataPath);
        } else if ('sql' in migration && migration.sql) {
          database.exec(migration.sql);
        }
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

  runMigrations(db, userDataPath);

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
