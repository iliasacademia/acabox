import { randomUUID } from 'crypto';
import { getDatabase } from './database';

export type BriefingType =
  | 'suggested_action'
  | 'suggested_tool'
  | 'paper'
  | 'citation'
  | 'grant'
  | 'writing_agent';

export type BriefingStatus = 'new' | 'opened' | 'dismissed';

export interface Briefing {
  id: string;
  workspace_id: string;
  type: BriefingType;
  briefing_data: string;
  why_im_suggesting_this: string | null;
  status: BriefingStatus;
  source_report_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBriefingInput {
  workspaceId: string;
  type: BriefingType;
  briefingData: unknown;
  whyImSuggestingThis?: string | null;
  sourceReportId?: string | null;
}

export function createBriefing(input: CreateBriefingInput): string {
  const db = getDatabase();
  const id = randomUUID();
  const dataJson =
    typeof input.briefingData === 'string'
      ? input.briefingData
      : JSON.stringify(input.briefingData);

  db.prepare(
    `INSERT INTO briefings (id, workspace_id, type, briefing_data, why_im_suggesting_this, source_report_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId,
    input.type,
    dataJson,
    input.whyImSuggestingThis ?? null,
    input.sourceReportId ?? null,
  );

  return id;
}

export interface ListBriefingsFilter {
  status?: BriefingStatus[];
  type?: BriefingType[];
  limit?: number;
}

export function listBriefings(
  workspaceId: string,
  filter: ListBriefingsFilter = {},
): Briefing[] {
  const db = getDatabase();
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];

  if (filter.status && filter.status.length > 0) {
    clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
    params.push(...filter.status);
  }

  if (filter.type && filter.type.length > 0) {
    clauses.push(`type IN (${filter.type.map(() => '?').join(', ')})`);
    params.push(...filter.type);
  }

  let sql = `SELECT * FROM briefings WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(sort_order, 999999), created_at DESC`;
  if (typeof filter.limit === 'number') {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  return db.prepare(sql).all(...params) as Briefing[];
}

export function getBriefingById(id: string): Briefing | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM briefings WHERE id = ?').get(id) as Briefing | undefined;
}

export function setBriefingStatus(id: string, status: BriefingStatus): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE briefings
     SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
     WHERE id = ?`,
  ).run(status, id);
}

export type SuggestionType = 'suggested_action' | 'suggested_tool';

const SUGGESTION_TYPES: SuggestionType[] = ['suggested_action', 'suggested_tool'];

export interface UpdateBriefingInput {
  briefingData?: unknown;
  whyImSuggestingThis?: string | null;
  type?: SuggestionType;
}

export function updateBriefing(id: string, updates: UpdateBriefingInput): void {
  const db = getDatabase();
  const row = db.prepare('SELECT type FROM briefings WHERE id = ?').get(id) as { type: string } | undefined;
  if (!row || !SUGGESTION_TYPES.includes(row.type as SuggestionType)) return;

  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')"];
  const params: unknown[] = [];

  if (updates.briefingData !== undefined) {
    sets.push('briefing_data = ?');
    params.push(typeof updates.briefingData === 'string' ? updates.briefingData : JSON.stringify(updates.briefingData));
  }
  if (updates.whyImSuggestingThis !== undefined) {
    sets.push('why_im_suggesting_this = ?');
    params.push(updates.whyImSuggestingThis);
  }
  if (updates.type !== undefined) {
    sets.push('type = ?');
    params.push(updates.type);
  }

  params.push(id);
  db.prepare(`UPDATE briefings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteBriefing(id: string, workspaceId: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT type FROM briefings WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as { type: string } | undefined;
  if (!row || !SUGGESTION_TYPES.includes(row.type as SuggestionType)) return false;

  db.prepare('DELETE FROM briefings WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return true;
}

export function reorderBriefings(workspaceId: string, orderedIds: string[]): void {
  const db = getDatabase();
  const stmt = db.prepare(
    `UPDATE briefings SET sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
     WHERE id = ? AND workspace_id = ? AND type IN ('suggested_action', 'suggested_tool')`,
  );
  db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      stmt.run(i, orderedIds[i], workspaceId);
    }
  })();
}
