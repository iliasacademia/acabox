import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import { createLocalConversationDb } from './localConversationDbFactory';

export type { LocalConversationDb } from './localConversationDbFactory';
export { createLocalConversationDb } from './localConversationDbFactory';

const DB_NAME = app.isPackaged ? 'local-conversations.db' : 'local-conversations-dev.db';
const dbPath = path.join(app.getPath('userData'), DB_NAME);

let instance: ReturnType<typeof createLocalConversationDb> | null = null;

export function getLocalConversationDb() {
  if (!instance) {
    instance = createLocalConversationDb(new Database(dbPath));
  }
  return instance;
}
