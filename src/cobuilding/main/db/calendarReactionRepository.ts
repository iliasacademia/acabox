import { randomUUID } from 'crypto';
import { getDatabase } from './database';
import type { CalendarReaction, CreateReactionData } from '../../shared/types';

export function createReaction(workspaceId: string, data: CreateReactionData): CalendarReaction {
  const id = randomUUID();
  getDatabase()
    .prepare(
      `INSERT INTO calendar_reactions
         (id, workspace_id, event_id, plan_id, title, content, trigger_context)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      workspaceId,
      data.event_id ?? null,
      data.plan_id ?? null,
      data.title,
      data.content,
      data.trigger_context
    );
  return getReaction(id)!;
}

export function getReaction(id: string): CalendarReaction | undefined {
  return getDatabase()
    .prepare(`SELECT * FROM calendar_reactions WHERE id = ?`)
    .get(id) as CalendarReaction | undefined;
}

export function listReactions(
  workspaceId: string,
  opts: { includeRead?: boolean; includeDismissed?: boolean } = {}
): CalendarReaction[] {
  const statusFilter: string[] = ['unread'];
  if (opts.includeRead) statusFilter.push('read');
  if (opts.includeDismissed) statusFilter.push('dismissed');

  const placeholders = statusFilter.map(() => '?').join(', ');
  const sql = `
    SELECT cr.*
    FROM calendar_reactions cr
    LEFT JOIN calendar_events ce ON cr.event_id = ce.id
    WHERE cr.workspace_id = ?
      AND cr.status IN (${placeholders})
    ORDER BY
      CASE WHEN cr.event_id IS NOT NULL THEN ce.start_at ELSE '9999' END ASC,
      cr.created_at DESC
  `;
  return getDatabase()
    .prepare(sql)
    .all(workspaceId, ...statusFilter) as CalendarReaction[];
}

export function countUnreadReactions(workspaceId: string): number {
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) as count FROM calendar_reactions
       WHERE workspace_id = ? AND status = 'unread'`
    )
    .get(workspaceId) as { count: number };
  return row.count;
}

export function updateReactionStatus(
  id: string,
  status: 'unread' | 'read' | 'dismissed'
): CalendarReaction | undefined {
  getDatabase()
    .prepare(
      `UPDATE calendar_reactions
       SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
       WHERE id = ?`
    )
    .run(status, id);
  return getReaction(id);
}

export function deleteReaction(id: string): void {
  getDatabase().prepare(`DELETE FROM calendar_reactions WHERE id = ?`).run(id);
}

// Returns true if a reaction already exists for this entity (event or plan) since the given ISO timestamp.
export function hasRecentReactionForEntity(workspaceId: string, entityId: string, since: string): boolean {
  const row = getDatabase()
    .prepare(
      `SELECT 1 FROM calendar_reactions
       WHERE workspace_id = ?
         AND (event_id = ? OR plan_id = ?)
         AND created_at > ?
       LIMIT 1`
    )
    .get(workspaceId, entityId, entityId, since);
  return !!row;
}

export function pruneOldDismissedReactions(workspaceId: string, olderThanDays: number): number {
  const result = getDatabase()
    .prepare(
      `DELETE FROM calendar_reactions
       WHERE workspace_id = ?
         AND status = 'dismissed'
         AND updated_at < datetime('now', ? || ' days')`
    )
    .run(workspaceId, `-${olderThanDays}`) as { changes: number };
  return result.changes;
}
