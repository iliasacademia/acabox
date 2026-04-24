import { randomUUID } from 'crypto';
import { getDatabase } from './database';
import { getEvent, updateEvent } from './calendarRepository';
import type { EventDependency, CreateDependencyData, UpdateDependencyData, CascadeUpdate } from '../../shared/types';

export function createDependency(data: CreateDependencyData): EventDependency {
  const id = randomUUID();
  const lagMin = data.lag_min_ms ?? 0;
  const lagMax = data.lag_max_ms ?? null;
  const lagCurrent = data.lag_current_ms ?? lagMin;
  getDatabase()
    .prepare(`INSERT INTO event_dependencies (id, predecessor_id, successor_id, lag_min_ms, lag_max_ms, lag_current_ms) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, data.predecessor_id, data.successor_id, lagMin, lagMax, lagCurrent);
  return getDependency(id)!;
}

export function getDependency(id: string): EventDependency | undefined {
  return getDatabase()
    .prepare(`SELECT * FROM event_dependencies WHERE id = ?`)
    .get(id) as EventDependency | undefined;
}

export function getPredecessors(eventId: string): EventDependency[] {
  return getDatabase()
    .prepare(`SELECT * FROM event_dependencies WHERE successor_id = ?`)
    .all(eventId) as EventDependency[];
}

export function getSuccessors(eventId: string): EventDependency[] {
  return getDatabase()
    .prepare(`SELECT * FROM event_dependencies WHERE predecessor_id = ?`)
    .all(eventId) as EventDependency[];
}

export function listDependenciesByWorkspace(workspaceId: string): EventDependency[] {
  return getDatabase()
    .prepare(`
      SELECT ed.* FROM event_dependencies ed
      JOIN calendar_events ce ON ce.id = ed.predecessor_id
      WHERE ce.workspace_id = ?
    `)
    .all(workspaceId) as EventDependency[];
}

export function updateDependency(id: string, data: UpdateDependencyData): EventDependency | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  if ('lag_min_ms' in data) { fields.push('lag_min_ms = ?'); values.push(data.lag_min_ms); }
  if ('lag_max_ms' in data) { fields.push('lag_max_ms = ?'); values.push(data.lag_max_ms ?? null); }
  if ('lag_current_ms' in data) { fields.push('lag_current_ms = ?'); values.push(data.lag_current_ms); }
  if (fields.length === 0) return getDependency(id);
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')`);
  values.push(id);
  getDatabase()
    .prepare(`UPDATE event_dependencies SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return getDependency(id);
}

export function deleteDependency(id: string): void {
  getDatabase().prepare(`DELETE FROM event_dependencies WHERE id = ?`).run(id);
}

// DFS from successorId following existing successor edges.
// Returns true if adding (predecessorId → successorId) would create a cycle.
export function hasCycle(predecessorId: string, successorId: string): boolean {
  const stmt = getDatabase().prepare<[string], { successor_id: string }>(
    `SELECT successor_id FROM event_dependencies WHERE predecessor_id = ?`
  );
  const visited = new Set<string>();
  const stack = [successorId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === predecessorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const { successor_id } of stmt.all(current)) {
      stack.push(successor_id);
    }
  }
  return false;
}

// BFS topological traversal from movedEventId. For each successor, computes
// newStart = max(all predecessor ends + lag_current_ms), preserving duration.
// Returns all affected events with their new times. Does NOT write to DB.
export function computeCascade(movedEventId: string): CascadeUpdate[] {
  const db = getDatabase();
  const getEventTimes = db.prepare<[string], { id: string; start_at: string; end_at: string }>(
    `SELECT id, start_at, end_at FROM calendar_events WHERE id = ?`
  );
  const getSuccessorDeps = db.prepare<[string], EventDependency>(
    `SELECT * FROM event_dependencies WHERE predecessor_id = ?`
  );
  const getPredecessorDeps = db.prepare<[string], EventDependency>(
    `SELECT * FROM event_dependencies WHERE successor_id = ?`
  );

  const updates = new Map<string, { start_at: string; end_at: string }>();

  function getEffective(id: string): { start_at: string; end_at: string } | undefined {
    return updates.get(id) ?? getEventTimes.get(id);
  }

  const queue: string[] = [movedEventId];
  const processed = new Set<string>([movedEventId]);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const dep of getSuccessorDeps.all(currentId)) {
      const succId = dep.successor_id;
      // Compute new start as the latest of all predecessor ends + their lag
      const predDeps = getPredecessorDeps.all(succId);
      let latestPredEnd = 0;
      for (const pd of predDeps) {
        const pred = getEffective(pd.predecessor_id);
        if (!pred) continue;
        const predEndMs = new Date(pred.end_at).getTime() + pd.lag_current_ms;
        if (predEndMs > latestPredEnd) latestPredEnd = predEndMs;
      }
      if (latestPredEnd === 0) continue;

      const orig = getEventTimes.get(succId);
      if (!orig) continue;
      // Loose ordering: only push forward, never pull backward
      if (latestPredEnd <= new Date(orig.start_at).getTime()) continue;
      const duration = new Date(orig.end_at).getTime() - new Date(orig.start_at).getTime();
      const newStart = new Date(latestPredEnd);
      const newEnd = new Date(latestPredEnd + duration);
      updates.set(succId, { start_at: newStart.toISOString(), end_at: newEnd.toISOString() });

      if (!processed.has(succId)) {
        processed.add(succId);
        queue.push(succId);
      }
    }
  }

  return Array.from(updates.entries()).map(([eventId, times]) => ({
    eventId,
    newStartAt: times.start_at,
    newEndAt: times.end_at,
  }));
}

// Wraps computeCascade in a transaction and writes all updates atomically.
export function applyCascade(movedEventId: string): CascadeUpdate[] {
  const cascadeUpdates = computeCascade(movedEventId);
  if (cascadeUpdates.length === 0) return [];
  const stmt = getDatabase().prepare(
    `UPDATE calendar_events SET start_at = ?, end_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?`
  );
  getDatabase().transaction(() => {
    for (const u of cascadeUpdates) {
      stmt.run(u.newStartAt, u.newEndAt, u.eventId);
    }
  })();
  return cascadeUpdates;
}

// Adjusts lag_current_ms (clamped to [lag_min_ms, lag_max_ms]), then cascades.
export function adjustBufferAndCascade(
  depId: string,
  newLagCurrentMs: number,
): { dependency: EventDependency; cascaded: CascadeUpdate[] } {
  const dep = getDependency(depId);
  if (!dep) throw new Error(`Dependency ${depId} not found`);
  const clamped = Math.max(
    dep.lag_min_ms,
    dep.lag_max_ms !== null ? Math.min(newLagCurrentMs, dep.lag_max_ms) : newLagCurrentMs,
  );
  const updated = updateDependency(depId, { lag_current_ms: clamped })!;
  // Move the successor to its new position, then cascade from there
  const pred = getEvent(dep.predecessor_id);
  if (!pred) return { dependency: updated, cascaded: [] };
  const succ = getEvent(dep.successor_id);
  if (!succ) return { dependency: updated, cascaded: [] };
  const duration = new Date(succ.end_at).getTime() - new Date(succ.start_at).getTime();
  const newStart = new Date(new Date(pred.end_at).getTime() + updated.lag_current_ms);
  const newEnd = new Date(newStart.getTime() + duration);
  updateEvent(dep.successor_id, { start_at: newStart.toISOString(), end_at: newEnd.toISOString() });
  const cascaded = applyCascade(dep.successor_id);
  // Include the immediate successor in cascaded list
  cascaded.unshift({ eventId: dep.successor_id, newStartAt: newStart.toISOString(), newEndAt: newEnd.toISOString() });
  return { dependency: updated, cascaded };
}
