import Database from 'better-sqlite3';

export interface LocalConversationDb {
  db: Database.Database;

  // Conversations
  insertConversation: Database.Statement;
  getConversation: Database.Statement;
  listConversations: Database.Statement;
  listArchivedConversations: Database.Statement;
  countConversations: Database.Statement;
  countArchivedConversations: Database.Statement;
  archiveConversation: Database.Statement;
  unarchiveConversation: Database.Statement;
  updateConversationTitle: Database.Statement;
  updateConversationSummary: Database.Statement;

  // Messages
  insertMessage: Database.Statement;
  getMessages: Database.Statement;
}

export function createLocalConversationDb(db: Database.Database): LocalConversationDb {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      archived_at TEXT,
      parent_type TEXT,
      summary TEXT,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parent_id INTEGER,
      user_id INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT,
      data TEXT,
      format TEXT,
      role TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      user_id INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);

  const insertConversation = db.prepare(
    `INSERT INTO conversations (agent_name, parent_type, summary, title, created_at, updated_at, parent_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const getConversation = db.prepare(
    `SELECT * FROM conversations WHERE id = ?`
  );

  const listConversations = db.prepare(
    `SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`
  );

  const listArchivedConversations = db.prepare(
    `SELECT * FROM conversations WHERE archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT ? OFFSET ?`
  );

  const countConversations = db.prepare(
    `SELECT COUNT(*) as count FROM conversations WHERE archived_at IS NULL`
  );

  const countArchivedConversations = db.prepare(
    `SELECT COUNT(*) as count FROM conversations WHERE archived_at IS NOT NULL`
  );

  const archiveConversation = db.prepare(
    `UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?`
  );

  const unarchiveConversation = db.prepare(
    `UPDATE conversations SET archived_at = NULL, updated_at = ? WHERE id = ?`
  );

  const updateConversationTitle = db.prepare(
    `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`
  );

  const updateConversationSummary = db.prepare(
    `UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?`
  );

  const insertMessage = db.prepare(
    `INSERT INTO conversation_messages (content, data, format, role, created_at, updated_at, conversation_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const getMessages = db.prepare(
    `SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`
  );

  return {
    db,
    insertConversation,
    getConversation,
    listConversations,
    listArchivedConversations,
    countConversations,
    countArchivedConversations,
    archiveConversation,
    unarchiveConversation,
    updateConversationTitle,
    updateConversationSummary,
    insertMessage,
    getMessages,
  };
}
