import { randomUUID } from 'crypto';
import { getDatabase } from './database';

export interface AppNotification {
  id: string;
  workspace_id: string;
  type: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface CreateNotificationInput {
  workspaceId: string;
  type: string;
  title: string;
  body?: string;
}

export function createNotification(input: CreateNotificationInput): string {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO notifications (id, workspace_id, type, title, body)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.workspaceId, input.type, input.title, input.body ?? '');
  return id;
}

export function getUnreadCount(workspaceId: string): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM notifications WHERE workspace_id = ? AND read_at IS NULL`,
  ).get(workspaceId) as { count: number };
  return row.count;
}

export function markAllAsRead(workspaceId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE notifications
     SET read_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
     WHERE workspace_id = ? AND read_at IS NULL`,
  ).run(workspaceId);
}

export function listNotifications(workspaceId: string, limit = 20): AppNotification[] {
  const db = getDatabase();
  return db.prepare(
    `SELECT * FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(workspaceId, limit) as AppNotification[];
}

