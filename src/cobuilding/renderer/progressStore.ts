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
// Keyed by threadId. A single global label cross-talked: the stall watchdog
// writes RECONNECTING from a per-thread run, so a background thread that
// stalled painted RECONNECTING… onto whatever thread the user was actually
// looking at (B15). Tool/subagent progress stay flat maps — they are keyed by
// toolCallId, which is already globally unique.
let processingLabels = new Map<string, string>();
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

/**
 * Sentinel processing label meaning "the host says this turn is still running
 * but no events are reaching us". Rendered distinctly by the thread's working
 * indicator so a broken pipe never masquerades as normal thinking.
 */
export const RECONNECTING_LABEL = '__reconnecting__';

export function setProcessingLabel(threadId: string, label: string | null): void {
  const current = processingLabels.get(threadId) ?? null;
  if (current === label) return;
  processingLabels = new Map(processingLabels);
  if (label === null) processingLabels.delete(threadId);
  else processingLabels.set(threadId, label);
  notify();
}

function getProcessingLabelsSnapshot(): Map<string, string> {
  return processingLabels;
}

/** Null for an unknown/absent thread, so a surface with no remoteId yet just
 *  renders the default indicator rather than another thread's label. */
export function useProcessingLabel(threadId: string | undefined): string | null {
  const labels = useSyncExternalStore(subscribe, getProcessingLabelsSnapshot);
  return threadId ? labels.get(threadId) ?? null : null;
}

/** Clears tool/subagent progress, plus the label for `threadId`. Omitting the
 *  id clears every thread's label — only correct for a surface that owns the
 *  whole store (no caller does today; pass the id). */
export function resetProgress(threadId?: string): void {
  toolProgress = new Map();
  subagentProgress = new Map();
  if (threadId === undefined) {
    processingLabels = new Map();
  } else if (processingLabels.has(threadId)) {
    processingLabels = new Map(processingLabels);
    processingLabels.delete(threadId);
  }
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
