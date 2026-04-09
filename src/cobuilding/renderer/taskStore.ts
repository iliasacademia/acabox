import { useSyncExternalStore } from 'react';

export interface TaskItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

let tasks: TaskItem[] | null = null;

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): TaskItem[] | null {
  return tasks;
}

export function setTasks(todos: TaskItem[]): void {
  tasks = todos;
  notify();
}

export function clearTasks(): void {
  if (tasks === null) return;
  tasks = null;
  notify();
}

/** Try to parse partial or complete TodoWrite argsText and update the store. */
export function tryUpdateTasksFromArgs(argsText: string): void {
  try {
    const parsed = JSON.parse(argsText);
    if (parsed?.todos && Array.isArray(parsed.todos)) {
      setTasks(parsed.todos);
    }
  } catch {
    // Incomplete JSON during streaming — ignore
  }
}

export function useTasks(): TaskItem[] | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
