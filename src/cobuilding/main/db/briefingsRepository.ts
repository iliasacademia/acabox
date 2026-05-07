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

  let sql = `SELECT * FROM briefings WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`;
  if (typeof filter.limit === 'number') {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  return db.prepare(sql).all(...params) as Briefing[];
}

export function setBriefingStatus(id: string, status: BriefingStatus): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE briefings
     SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
     WHERE id = ?`,
  ).run(status, id);
}

