import { randomUUID } from 'crypto';
import { getDatabase } from './database';
import type { CalendarPlan, CalendarEvent, EventFile, PlanFile, CreatePlanData, UpdatePlanData, CreateEventData, UpdateEventData } from '../../shared/types';

// ---- Plans ----

export function createPlan(workspaceId: string, data: CreatePlanData): CalendarPlan {
  const id = randomUUID();
  getDatabase()
    .prepare(`INSERT INTO plans (id, workspace_id, name, color) VALUES (?, ?, ?, ?)`)
    .run(id, workspaceId, data.name, data.color);
  return getPlan(id)!;
}

export function getPlan(id: string): CalendarPlan | undefined {
  return getDatabase()
    .prepare(`SELECT * FROM plans WHERE id = ?`)
    .get(id) as CalendarPlan | undefined;
}

export function listPlans(workspaceId: string): CalendarPlan[] {
  return getDatabase()
    .prepare(`SELECT * FROM plans WHERE workspace_id = ? ORDER BY created_at ASC`)
    .all(workspaceId) as CalendarPlan[];
}

export function updatePlan(id: string, data: UpdatePlanData): CalendarPlan | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color); }
  if (fields.length === 0) return getPlan(id);
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')`);
  values.push(id);
  getDatabase()
    .prepare(`UPDATE plans SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return getPlan(id);
}

export function deletePlan(id: string): void {
  getDatabase().prepare(`DELETE FROM plans WHERE id = ?`).run(id);
}

export function getPlanTimeRange(planId: string): { start_at: string; end_at: string } | null {
  const row = getDatabase()
    .prepare(`SELECT MIN(start_at) AS start_at, MAX(end_at) AS end_at FROM calendar_events WHERE plan_id = ?`)
    .get(planId) as { start_at: string | null; end_at: string | null } | undefined;
  if (!row || row.start_at == null) return null;
  return { start_at: row.start_at, end_at: row.end_at! };
}

// ---- Events ----

export function createEvent(workspaceId: string, data: CreateEventData): CalendarEvent {
  const id = randomUUID();
  getDatabase()
    .prepare(`
      INSERT INTO calendar_events
        (id, workspace_id, plan_id, name, start_at, end_at, status, color,
         recurrence_rule, recurrence_parent_id, recurrence_exception_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      workspaceId,
      data.plan_id ?? null,
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
  planId?: string;
  mastersOnly?: boolean;
}

export function listEvents(workspaceId: string, opts: ListEventsOptions = {}): CalendarEvent[] {
  const conditions: string[] = ['workspace_id = ?'];
  const values: unknown[] = [workspaceId];

  if (opts.from) { conditions.push('end_at >= ?'); values.push(opts.from); }
  if (opts.to) { conditions.push('start_at <= ?'); values.push(opts.to); }
  if (opts.planId) { conditions.push('plan_id = ?'); values.push(opts.planId); }
  if (opts.mastersOnly) { conditions.push('recurrence_parent_id IS NULL'); }

  return getDatabase()
    .prepare(`SELECT * FROM calendar_events WHERE ${conditions.join(' AND ')} ORDER BY start_at ASC`)
    .all(...values) as CalendarEvent[];
}

export function updateEvent(id: string, data: UpdateEventData): CalendarEvent | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if ('plan_id' in data) { fields.push('plan_id = ?'); values.push(data.plan_id ?? null); }
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

// ---- Plan files ----

export function addPlanFile(planId: string, filePath: string): PlanFile {
  const result = getDatabase()
    .prepare(`INSERT INTO plan_files (plan_id, file_path) VALUES (?, ?)`)
    .run(planId, filePath);
  return getDatabase()
    .prepare(`SELECT * FROM plan_files WHERE id = ?`)
    .get(result.lastInsertRowid) as PlanFile;
}

export function listPlanFiles(planId: string, includeFromEvents = false): PlanFile[] {
  if (!includeFromEvents) {
    return getDatabase()
      .prepare(`SELECT * FROM plan_files WHERE plan_id = ? ORDER BY created_at ASC`)
      .all(planId) as PlanFile[];
  }

  // UNION directly-attached plan files with files from child events.
  // Event file rows are shaped to match PlanFile (id, plan_id, file_path, created_at).
  return getDatabase()
    .prepare(`
      SELECT id, plan_id, file_path, created_at FROM plan_files WHERE plan_id = ?
      UNION ALL
      SELECT ef.id, ce.plan_id, ef.file_path, ef.created_at
        FROM event_files ef
        JOIN calendar_events ce ON ce.id = ef.event_id
        WHERE ce.plan_id = ?
      ORDER BY created_at ASC
    `)
    .all(planId, planId) as PlanFile[];
}

export function removePlanFile(id: number): void {
  getDatabase().prepare(`DELETE FROM plan_files WHERE id = ?`).run(id);
}
