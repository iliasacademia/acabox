import { useSyncExternalStore } from 'react';

/**
 * Live per-tool runtime status, written by MiniAppViewer (dependency gate +
 * rebuild flow) and read by the tool tab bar and viewer header. A tool with
 * no entry is 'running' — the viewer only mounts for open tabs, and there is
 * no host-side mini-app lifecycle yet.
 */
export type ToolRuntimeStatus =
  | { kind: 'running' }
  | { kind: 'installing'; done: number; total: number }
  | { kind: 'building' }
  | { kind: 'buildFailed'; message: string; at: number };

let statuses = new Map<string, ToolRuntimeStatus>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): Map<string, ToolRuntimeStatus> {
  return statuses;
}

export function setToolStatus(dirName: string, status: ToolRuntimeStatus): void {
  statuses = new Map(statuses);
  statuses.set(dirName, status);
  notify();
}

export function clearToolStatus(dirName: string): void {
  if (!statuses.has(dirName)) return;
  statuses = new Map(statuses);
  statuses.delete(dirName);
  notify();
}

export function useToolStatus(dirName: string): ToolRuntimeStatus {
  const map = useSyncExternalStore(subscribe, getSnapshot);
  return map.get(dirName) ?? { kind: 'running' };
}

export function useToolStatuses(): Map<string, ToolRuntimeStatus> {
  return useSyncExternalStore(subscribe, getSnapshot);
}
