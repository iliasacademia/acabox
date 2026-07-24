import { useSyncExternalStore } from 'react';

interface ToolProgressEntry {
  toolName: string;
  elapsedSeconds: number;
}

export interface SubagentProgress {
  taskId: string;
  description: string;
  summary?: string;
  lastToolName?: string;
  toolUseCount: number;
  durationMs: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
}

let toolProgress = new Map<string, ToolProgressEntry>();
let subagentProgress = new Map<string, SubagentProgress>();
let processingLabel: string | null = null;
// Last observed elapsed time for finished tool calls, so completed cards can
// show a real measured duration for the current renderer session. Not
// persisted — history rows render without a duration.
let finalElapsed = new Map<string, number>();

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getToolSnapshot(): Map<string, ToolProgressEntry> {
  return toolProgress;
}

function getSubagentSnapshot(): Map<string, SubagentProgress> {
  return subagentProgress;
}

export function setToolProgress(toolCallId: string, toolName: string, elapsedSeconds: number): void {
  toolProgress = new Map(toolProgress);
  toolProgress.set(toolCallId, { toolName, elapsedSeconds });
  notify();
}

export function clearToolProgress(toolCallId: string): void {
  if (!toolProgress.has(toolCallId)) return;
  const entry = toolProgress.get(toolCallId);
  if (entry) {
    finalElapsed = new Map(finalElapsed);
    finalElapsed.set(toolCallId, entry.elapsedSeconds);
  }
  toolProgress = new Map(toolProgress);
  toolProgress.delete(toolCallId);
  notify();
}

function getFinalElapsedSnapshot(): Map<string, number> {
  return finalElapsed;
}

/** Measured duration of a completed tool call (this renderer session only). */
export function useToolFinalElapsed(toolCallId: string): number | null {
  const finished = useSyncExternalStore(subscribe, getFinalElapsedSnapshot);
  return finished.get(toolCallId) ?? null;
}

export function setSubagentStarted(parentToolCallId: string, taskId: string, description: string): void {
  subagentProgress = new Map(subagentProgress);
  subagentProgress.set(parentToolCallId, {
    taskId,
    description,
    toolUseCount: 0,
    durationMs: 0,
    status: 'running',
  });
  notify();
}

export function updateSubagentProgress(
  parentToolCallId: string,
  data: { summary?: string; lastToolName?: string; toolUseCount: number; durationMs: number },
): void {
  const existing = subagentProgress.get(parentToolCallId);
  if (!existing) return;
  subagentProgress = new Map(subagentProgress);
  subagentProgress.set(parentToolCallId, { ...existing, ...data });
  notify();
}

export function setSubagentDone(parentToolCallId: string, status: 'completed' | 'failed' | 'stopped', summary: string): void {
  const existing = subagentProgress.get(parentToolCallId);
  if (!existing) return;
  subagentProgress = new Map(subagentProgress);
  subagentProgress.set(parentToolCallId, { ...existing, status, summary });
  notify();
}

export function setProcessingLabel(label: string | null): void {
  if (processingLabel === label) return;
  processingLabel = label;
  notify();
}

function getProcessingLabelSnapshot(): string | null {
  return processingLabel;
}

export function useProcessingLabel(): string | null {
  return useSyncExternalStore(subscribe, getProcessingLabelSnapshot);
}

export function resetProgress(): void {
  toolProgress = new Map();
  subagentProgress = new Map();
  processingLabel = null;
  notify();
}

export function useToolElapsed(toolCallId: string): number | null {
  const progress = useSyncExternalStore(subscribe, getToolSnapshot);
  return progress.get(toolCallId)?.elapsedSeconds ?? null;
}

export function useSubagentProgress(parentToolCallId: string): SubagentProgress | null {
  const progress = useSyncExternalStore(subscribe, getSubagentSnapshot);
  return progress.get(parentToolCallId) ?? null;
}
