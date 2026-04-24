import { randomUUID } from 'crypto';
import { getDatabase } from './database';
import type {
  CalendarResource,
  CreateResourceData,
  UpdateResourceData,
  MoveResourceData,
  ListResourcesOptions,
} from '../../shared/types';

function nextSortOrder(
  workspaceId: string,
  parentId: string | null,
  planId: string | null,
  eventId: string | null,
): number {
  const conditions: string[] = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];

  if (parentId !== null) {
    conditions.push('parent_id = ?');
    params.push(parentId);
  } else {
    conditions.push('parent_id IS NULL');
    if (eventId) { conditions.push('event_id = ?'); params.push(eventId); }
    else if (planId) { conditions.push('plan_id = ?'); params.push(planId); }
    else { conditions.push('event_id IS NULL AND plan_id IS NULL'); }
  }

  const row = getDatabase()
    .prepare(`SELECT MAX(sort_order) as mx FROM calendar_resources WHERE ${conditions.join(' AND ')}`)
    .get(...params) as { mx: number | null } | undefined;
  return (row?.mx ?? -1) + 1;
}

export function createResource(workspaceId: string, data: CreateResourceData): CalendarResource {
  const id = randomUUID();
  const title = data.title ?? '';
  const sortOrder = data.sort_order ?? nextSortOrder(
    workspaceId,
    data.parent_id ?? null,
    data.plan_id ?? null,
    data.event_id ?? null,
  );
  getDatabase()
    .prepare(
      `INSERT INTO calendar_resources
         (id, workspace_id, type, event_id, plan_id, parent_id, file_path, url, note_content, title, sort_order, ai_generated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      workspaceId,
      data.type,
      data.event_id ?? null,
      data.plan_id ?? null,
      data.parent_id ?? null,
      data.file_path ?? null,
      data.url ?? null,
      data.note_content ?? null,
      title,
      sortOrder,
      data.ai_generated ? 1 : 0
    );
  return getResource(id)!;
}

export function getResource(id: string): CalendarResource | undefined {
  return getDatabase()
    .prepare(`SELECT * FROM calendar_resources WHERE id = ?`)
    .get(id) as CalendarResource | undefined;
}

export function listResources(
  workspaceId: string,
  opts: ListResourcesOptions = {}
): CalendarResource[] {
  const conditions: string[] = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];

  if (opts.event_id !== undefined) {
    conditions.push('event_id = ?');
    params.push(opts.event_id);
  }
  if (opts.plan_id !== undefined) {
    conditions.push('plan_id = ?');
    params.push(opts.plan_id);
  }
  if (opts.parent_id !== undefined) {
    if (opts.parent_id === null) {
      conditions.push('parent_id IS NULL');
    } else {
      conditions.push('parent_id = ?');
      params.push(opts.parent_id);
    }
  }
  if (opts.standalone) {
    conditions.push('event_id IS NULL AND plan_id IS NULL');
  }

  const sql = `SELECT * FROM calendar_resources WHERE ${conditions.join(' AND ')} ORDER BY sort_order ASC, created_at ASC`;
  return getDatabase().prepare(sql).all(...params) as CalendarResource[];
}

export function updateResource(
  id: string,
  data: UpdateResourceData
): CalendarResource | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.title !== undefined) { sets.push('title = ?'); params.push(data.title); }
  if (data.url !== undefined) { sets.push('url = ?'); params.push(data.url); }
  if (data.note_content !== undefined) { sets.push('note_content = ?'); params.push(data.note_content); }
  if (data.file_path !== undefined) { sets.push('file_path = ?'); params.push(data.file_path); }

  if (sets.length === 0) return getResource(id);

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')");
  params.push(id);

  getDatabase()
    .prepare(`UPDATE calendar_resources SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
  return getResource(id);
}

export function moveResource(id: string, data: MoveResourceData): CalendarResource | undefined {
  const current = getResource(id);
  if (!current) return undefined;

  const sets: string[] = [];
  const params: unknown[] = [];

  if ('plan_id' in data) { sets.push('plan_id = ?'); params.push(data.plan_id ?? null); }
  if ('event_id' in data) { sets.push('event_id = ?'); params.push(data.event_id ?? null); }
  if ('parent_id' in data) { sets.push('parent_id = ?'); params.push(data.parent_id ?? null); }
  if (data.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(data.sort_order); }

  if (sets.length === 0) return current;

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')");
  params.push(id);

  getDatabase()
    .prepare(`UPDATE calendar_resources SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
  return getResource(id);
}

export function deleteResource(id: string): void {
  const resource = getResource(id);
  if (resource) {
    // Orphan direct children — move them up to the deleted folder's parent scope
    getDatabase()
      .prepare(`UPDATE calendar_resources SET parent_id = ?, plan_id = ?, event_id = ? WHERE parent_id = ?`)
      .run(resource.parent_id, resource.plan_id, resource.event_id, id);
  }
  getDatabase().prepare(`DELETE FROM calendar_resources WHERE id = ?`).run(id);
}
