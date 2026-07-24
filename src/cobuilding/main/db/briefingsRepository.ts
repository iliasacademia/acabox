import { randomUUID } from 'crypto';
import { getDatabase } from './database';
import { track as trackAnalytics } from '../coscientistAnalytics';

export type BriefingType = 'writing_agent';

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

  // Telemetry — all briefings are agent-generated, so surface='background'.
  // Truncation helper handles long briefing_data / why_im_suggesting_this.
  trackAnalytics(
    {
      name: 'briefing.created',
      metadata: {
        briefing_id: id,
        type: input.type,
        source_report_id: input.sourceReportId ?? null,
        briefing_data: dataJson,
        why_im_suggesting_this: input.whyImSuggestingThis ?? '',
      },
    },
    { surface: 'background' },
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

  // Read the prior status + created_at before mutating, so we can fire the
  // right telemetry (only on the new→opened transition, and only with
  // was_ever_opened populated for dismissals).
  const prior = db
    .prepare('SELECT status, created_at FROM briefings WHERE id = ?')
    .get(id) as { status: BriefingStatus; created_at: string } | undefined;

  db.prepare(
    `UPDATE briefings
     SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
     WHERE id = ?`,
  ).run(status, id);

  if (!prior) return;

  const createdAtMs = new Date(prior.created_at).getTime();
  const secondsSinceCreated = Math.max(
    0,
    Math.floor((Date.now() - createdAtMs) / 1000),
  );

  if (status === 'opened' && prior.status === 'new') {
    trackAnalytics({
      name: 'briefing.opened',
      metadata: { briefing_id: id, seconds_since_created: secondsSinceCreated },
    });
  } else if (status === 'dismissed' && prior.status !== 'dismissed') {
    trackAnalytics({
      name: 'briefing.dismissed',
      metadata: {
        briefing_id: id,
        seconds_since_created: secondsSinceCreated,
        was_ever_opened: prior.status === 'opened',
      },
    });
  }
}

