import { useSyncExternalStore } from 'react';

/**
 * Tracks whether the initial environment setup (podman + base image) is complete.
 * Components read this to block interactions that require the container/agent.
 */

type SetupState = 'pending' | 'downloading' | 'ready' | 'error';

let setupState: SetupState = 'pending';
let setupMessage: string | null = null;
let setupPercent = 0;

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

function getSnapshot(): { state: SetupState; message: string | null; percent: number } {
  return { state: setupState, message: setupMessage, percent: setupPercent };
}

// Stable reference for useSyncExternalStore — only changes when values change
let snapshotRef = getSnapshot();

function getStableSnapshot() {
  return snapshotRef;
}

export function setSetupState(state: SetupState, message?: string | null, percent?: number): void {
  const newState = state;
  const newMessage = message ?? setupMessage;
  const newPercent = percent ?? setupPercent;
  if (setupState === newState && setupMessage === newMessage && setupPercent === newPercent) return;
  setupState = newState;
  setupMessage = newMessage;
  setupPercent = newPercent;
  snapshotRef = { state: setupState, message: setupMessage, percent: setupPercent };
  notify();
}

export function useSetupState(): { state: SetupState; message: string | null; percent: number } {
  return useSyncExternalStore(subscribe, getStableSnapshot);
}
