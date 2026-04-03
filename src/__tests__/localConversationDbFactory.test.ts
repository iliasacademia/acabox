import Database from 'better-sqlite3';
import { createLocalConversationDb, type LocalConversationDb } from '../localConversationDbFactory';

describe('localConversationDbFactory', () => {
  let lcDb: LocalConversationDb;

  beforeEach(() => {
    const db = new Database(':memory:');
    lcDb = createLocalConversationDb(db);
  });

  afterEach(() => {
    lcDb.db.close();
  });

  describe('table creation', () => {
    it('creates conversations and conversation_messages tables', () => {
      const tables = lcDb.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversations', 'conversation_messages') ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map(t => t.name)).toEqual(['conversation_messages', 'conversations']);
    });
  });

  describe('conversations', () => {
    const now = new Date().toISOString();

    function insertTestConversation(title = 'Test conversation') {
      const result = lcDb.insertConversation.run('ms_word', null, null, title, now, now, null, 1);
      return result.lastInsertRowid as number;
    }

    it('inserts and retrieves a conversation', () => {
      const id = insertTestConversation();
      const conv = lcDb.getConversation.get(id) as any;
      expect(conv).toBeDefined();
      expect(conv.title).toBe('Test conversation');
      expect(conv.agent_name).toBe('ms_word');
      expect(conv.user_id).toBe(1);
      expect(conv.archived_at).toBeNull();
    });

    it('lists non-archived conversations with pagination', () => {
      for (let i = 0; i < 5; i++) {
        insertTestConversation(`Conv ${i}`);
      }

      const page1 = lcDb.listConversations.all(3, 0) as any[];
      expect(page1).toHaveLength(3);

      const page2 = lcDb.listConversations.all(3, 3) as any[];
      expect(page2).toHaveLength(2);
    });

    it('counts non-archived conversations', () => {
      insertTestConversation();
      insertTestConversation();
      const result = lcDb.countConversations.get() as any;
      expect(result.count).toBe(2);
    });

    it('archives and unarchives a conversation', () => {
      const id = insertTestConversation();
      const archiveTime = new Date().toISOString();

      lcDb.archiveConversation.run(archiveTime, now, id);
      let conv = lcDb.getConversation.get(id) as any;
      expect(conv.archived_at).toBe(archiveTime);

      // Should not appear in non-archived list
      const active = lcDb.listConversations.all(100, 0) as any[];
      expect(active).toHaveLength(0);

      // Should appear in archived list
      const archived = lcDb.listArchivedConversations.all(100, 0) as any[];
      expect(archived).toHaveLength(1);

      // Count archived
      const archivedCount = lcDb.countArchivedConversations.get() as any;
      expect(archivedCount.count).toBe(1);

      // Unarchive
      lcDb.unarchiveConversation.run(now, id);
      conv = lcDb.getConversation.get(id) as any;
      expect(conv.archived_at).toBeNull();
    });

    it('updates conversation title', () => {
      const id = insertTestConversation();
      lcDb.updateConversationTitle.run('New title', now, id);
      const conv = lcDb.getConversation.get(id) as any;
      expect(conv.title).toBe('New title');
    });

    it('updates conversation summary', () => {
      const id = insertTestConversation();
      lcDb.updateConversationSummary.run('A summary', now, id);
      const conv = lcDb.getConversation.get(id) as any;
      expect(conv.summary).toBe('A summary');
    });
  });

  describe('messages', () => {
    const now = new Date().toISOString();

    it('inserts and retrieves messages for a conversation', () => {
      const convId = lcDb.insertConversation.run('ms_word', null, null, 'Test', now, now, null, 1).lastInsertRowid as number;

      lcDb.insertMessage.run('Hello', null, null, 'user', now, now, convId, 1);
      lcDb.insertMessage.run('Hi there', '{"tool_use":[]}', null, 'assistant', now, now, convId, null);

      const messages = lcDb.getMessages.all(convId) as any[];
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].data).toBe('{"tool_use":[]}');
    });

    it('enforces foreign key constraint on conversation_id', () => {
      expect(() => {
        lcDb.insertMessage.run('Hello', null, null, 'user', now, now, 9999, 1);
      }).toThrow();
    });
  });
});
