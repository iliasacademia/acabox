import { randomUUID } from 'crypto';
import { getDatabase } from './database';
import type { CalendarGroup, CalendarEvent, EventFile, GroupFile, CreateGroupData, UpdateGroupData, CreateEventData, UpdateEventData } from '../../shared/types';

// ---- Groups ----

export function createGroup(workspaceId: string, data: CreateGroupData): CalendarGroup {
  const id = randomUUID();
  getDatabase()
    .prepare(`INSERT INTO groups (id, workspace_id, name, color) VALUES (?, ?, ?, ?)`)
    .run(id, workspaceId, data.name, data.color);
  return getGroup(id)!;
}

export function getGroup(id: string): CalendarGroup | undefined {
  return getDatabase()
    .prepare(`SELECT * FROM groups WHERE id = ?`)
    .get(id) as CalendarGroup | undefined;
}

export function listGroups(workspaceId: string): CalendarGroup[] {
  return getDatabase()
    .prepare(`SELECT * FROM groups WHERE workspace_id = ? ORDER BY created_at ASC`)
    .all(workspaceId) as CalendarGroup[];
}

export function updateGroup(id: string, data: UpdateGroupData): CalendarGroup | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color); }
  if (fields.length === 0) return getGroup(id);
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')`);
  values.push(id);
  getDatabase()
    .prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return getGroup(id);
}

export function deleteGroup(id: string): void {
  getDatabase().prepare(`DELETE FROM groups WHERE id = ?`).run(id);
}

export function getGroupTimeRange(groupId: string): { start_at: string; end_at: string } | null {
  const row = getDatabase()
    .prepare(`SELECT MIN(start_at) AS start_at, MAX(end_at) AS end_at FROM calendar_events WHERE group_id = ?`)
    .get(groupId) as { start_at: string | null; end_at: string | null } | undefined;
  if (!row || row.start_at == null) return null;
  return { start_at: row.start_at, end_at: row.end_at! };
}

// ---- Events ----

export function createEvent(workspaceId: string, data: CreateEventData): CalendarEvent {
  const id = randomUUID();
  getDatabase()
    .prepare(`
      INSERT INTO calendar_events
        (id, workspace_id, group_id, name, start_at, end_at, status, color,
         recurrence_rule, recurrence_parent_id, recurrence_exception_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      workspaceId,
      data.group_id ?? null,
      data.name,
      data.start_at,
      data.end_at,
      data.status ?? 'active',
      data.color ?? null,
      data.recurrence_rule ?? null,
      data.recurrence_parent_id ?? null,
      data.recurrence_exception_date ?? null,
    );
  return getEvent(id)!;
}

export function getEvent(id: string): CalendarEvent | undefined {
  return getDatabase()
    .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
    .get(id) as CalendarEvent | undefined;
}

export interface ListEventsOptions {
  from?: string;
  to?: string;
  groupId?: string;
  mastersOnly?: boolean;
}

export function listEvents(workspaceId: string, opts: ListEventsOptions = {}): CalendarEvent[] {
  const conditions: string[] = ['workspace_id = ?'];
  const values: unknown[] = [workspaceId];

  if (opts.from) { conditions.push('end_at >= ?'); values.push(opts.from); }
  if (opts.to) { conditions.push('start_at <= ?'); values.push(opts.to); }
  if (opts.groupId) { conditions.push('group_id = ?'); values.push(opts.groupId); }
  if (opts.mastersOnly) { conditions.push('recurrence_parent_id IS NULL'); }

  return getDatabase()
    .prepare(`SELECT * FROM calendar_events WHERE ${conditions.join(' AND ')} ORDER BY start_at ASC`)
    .all(...values) as CalendarEvent[];
}

export function updateEvent(id: string, data: UpdateEventData): CalendarEvent | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if ('group_id' in data) { fields.push('group_id = ?'); values.push(data.group_id ?? null); }
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.start_at !== undefined) { fields.push('start_at = ?'); values.push(data.start_at); }
  if (data.end_at !== undefined) { fields.push('end_at = ?'); values.push(data.end_at); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  if ('color' in data) { fields.push('color = ?'); values.push(data.color ?? null); }
  if ('recurrence_rule' in data) { fields.push('recurrence_rule = ?'); values.push(data.recurrence_rule ?? null); }

  if (fields.length === 0) return getEvent(id);
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')`);
  values.push(id);

  getDatabase()
    .prepare(`UPDATE calendar_events SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return getEvent(id);
}

export function deleteEvent(id: string): void {
  getDatabase().prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
}

// ---- Event files ----

export function addEventFile(eventId: string, filePath: string): EventFile {
  const result = getDatabase()
    .prepare(`INSERT INTO event_files (event_id, file_path) VALUES (?, ?)`)
    .run(eventId, filePath);
  return getDatabase()
    .prepare(`SELECT * FROM event_files WHERE id = ?`)
    .get(result.lastInsertRowid) as EventFile;
}

export function listEventFiles(eventId: string): EventFile[] {
  return getDatabase()
    .prepare(`SELECT * FROM event_files WHERE event_id = ? ORDER BY created_at ASC`)
    .all(eventId) as EventFile[];
}

export function removeEventFile(id: number): void {
  getDatabase().prepare(`DELETE FROM event_files WHERE id = ?`).run(id);
}

// ---- Group files ----

export function addGroupFile(groupId: string, filePath: string): GroupFile {
  const result = getDatabase()
    .prepare(`INSERT INTO group_files (group_id, file_path) VALUES (?, ?)`)
    .run(groupId, filePath);
  return getDatabase()
    .prepare(`SELECT * FROM group_files WHERE id = ?`)
    .get(result.lastInsertRowid) as GroupFile;
}

export function listGroupFiles(groupId: string, includeFromEvents = false): GroupFile[] {
  if (!includeFromEvents) {
    return getDatabase()
      .prepare(`SELECT * FROM group_files WHERE group_id = ? ORDER BY created_at ASC`)
      .all(groupId) as GroupFile[];
  }

  // UNION directly-attached group files with files from child events.
  return getDatabase()
    .prepare(`
      SELECT id, group_id, file_path, created_at FROM group_files WHERE group_id = ?
      UNION ALL
      SELECT ef.id, ce.group_id, ef.file_path, ef.created_at
        FROM event_files ef
        JOIN calendar_events ce ON ce.id = ef.event_id
        WHERE ce.group_id = ?
      ORDER BY created_at ASC
    `)
    .all(groupId, groupId) as GroupFile[];
}

export function removeGroupFile(id: number): void {
  getDatabase().prepare(`DELETE FROM group_files WHERE id = ?`).run(id);
}
