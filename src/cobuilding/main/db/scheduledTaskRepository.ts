import { randomUUID } from 'crypto';
import { getSchedulingDatabase } from './schedulingDatabase';

export interface ScheduledTask {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  prompt: string;
  cron_expression: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  session_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export function listTasks(workspaceId: string): ScheduledTask[] {
  const db = getSchedulingDatabase();
  return db.prepare('SELECT * FROM scheduled_tasks WHERE workspace_id = ? ORDER BY created_at ASC').all(workspaceId) as ScheduledTask[];
}

export function getTask(id: string): ScheduledTask | undefined {
  const db = getSchedulingDatabase();
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function createTask(
  workspaceId: string,
  name: string,
  description: string,
  prompt: string,
  cronExpression: string,
): ScheduledTask {
  const db = getSchedulingDatabase();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO scheduled_tasks (id, workspace_id, name, description, prompt, cron_expression)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, workspaceId, name, description, prompt, cronExpression);
  return getTask(id)!;
}

export function updateTask(
  id: string,
  updates: Partial<Pick<ScheduledTask, 'name' | 'description' | 'prompt' | 'cron_expression' | 'enabled'>>,
): ScheduledTask | undefined {
  const db = getSchedulingDatabase();
  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getTask(id);

  fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')");
  values.push(id);

  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTask(id);
}

export function deleteTask(id: string): void {
  const db = getSchedulingDatabase();
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function setTaskEnabled(id: string, enabled: boolean): void {
  const db = getSchedulingDatabase();
  db.prepare("UPDATE scheduled_tasks SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function updateLastRun(id: string, lastRunAt: string, nextRunAt: string): void {
  const db = getSchedulingDatabase();
  db.prepare("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?").run(lastRunAt, nextRunAt, id);
}

export function getEnabledTasks(workspaceId: string): ScheduledTask[] {
  const db = getSchedulingDatabase();
  return db.prepare('SELECT * FROM scheduled_tasks WHERE workspace_id = ? AND enabled = 1').all(workspaceId) as ScheduledTask[];
}

export function createTaskRun(taskId: string, sessionId: string): string {
  const db = getSchedulingDatabase();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO scheduled_task_runs (id, task_id, session_id) VALUES (?, ?, ?)',
  ).run(id, taskId, sessionId);
  return id;
}

export function completeTaskRun(id: string, status: 'completed' | 'failed', error?: string): void {
  const db = getSchedulingDatabase();
  db.prepare(
    "UPDATE scheduled_task_runs SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now'), error = ? WHERE id = ?",
  ).run(status, error ?? null, id);
}

export function listTaskRuns(taskId: string, limit = 20): ScheduledTaskRun[] {
  const db = getSchedulingDatabase();
  return db.prepare('SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?').all(taskId, limit) as ScheduledTaskRun[];
}
