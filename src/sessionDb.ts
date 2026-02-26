import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import { createSessionDb } from './sessionDbFactory';

export type { SessionDb } from './sessionDbFactory';
export { createSessionDb } from './sessionDbFactory';

const DB_NAME = app.isPackaged ? 'sessions.db' : 'sessions-dev.db';
const dbPath = path.join(app.getPath('userData'), DB_NAME);

export const sessionDb = createSessionDb(new Database(dbPath));

export const { db, insertSession, updateEndTime, setUserId } = sessionDb;
