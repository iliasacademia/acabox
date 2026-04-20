import { useState, useCallback, useRef } from 'react';

export interface EditItem {
  id: string;
  description: string;
  type: 'replace' | 'insert' | 'delete';
  find?: string;
  replacement?: string;
  after?: string;
  content?: string;
  text?: string;
}

export interface ExecutionState {
  currentStep: number;   // 1-indexed, 0 = not yet started
  totalSteps: number;
  isRunning: boolean;
  error?: string;
  stopped?: boolean;
}

// True when running in the WKWebView overlay (no Electron IPC available).
// window.electronAPI is typed as always-present by global.d.ts but is actually
// absent in the WKWebView overlay — use 'in' to check at runtime.
const hasIpc = () => typeof window !== 'undefined' && 'electronAPI' in window && !!window.electronAPI;

// HTTP base URL: same origin as the overlay's web server.
const httpBase = () => (typeof window !== 'undefined' ? window.location.origin : '');

export function usePlanExecution(manuscriptFilePath: string | null) {
  const [executionState, setExecutionState] = useState<ExecutionState | null>(null);
  const listenerRef = useRef<((event: any, data: any) => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- IPC path (main Electron renderer) ---
  const executeViaIpc = useCallback(async (edits: EditItem[]) => {
    setExecutionState({ currentStep: 0, totalSteps: edits.length, isRunning: true });

    if (listenerRef.current) {
      window.electronAPI.removeListener('local-agent-stream-update', listenerRef.current);
    }

    const listener = (_event: any, data: any) => {
      if (!data.plan_execution) return;
      if (data.is_final) {
        setExecutionState((prev) =>
          prev
            ? {
                ...prev,
                currentStep: data.stopped ? prev.currentStep : prev.totalSteps,
                isRunning: false,
                error: data.error,
                stopped: data.stopped,
              }
            : null,
        );
        window.electronAPI.removeListener('local-agent-stream-update', listener);
        listenerRef.current = null;
      } else {
        setExecutionState((prev) =>
          prev ? { ...prev, currentStep: data.step ?? prev.currentStep } : null,
        );
      }
    };

    listenerRef.current = listener;
    window.electronAPI.on('local-agent-stream-update', listener);

    try {
      await window.electronAPI.invoke('local-agent-execute-plan', {
        edits,
        manuscriptFilePath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExecutionState((prev) =>
        prev ? { ...prev, isRunning: false, error: msg } : null,
      );
      if (listenerRef.current) {
        window.electronAPI.removeListener('local-agent-stream-update', listenerRef.current);
        listenerRef.current = null;
      }
    }
  }, [manuscriptFilePath]);

  const stopViaIpc = useCallback(() => {
    window.electronAPI.invoke('local-agent-stop', -1).catch(() => {});
    setExecutionState((prev) =>
      prev ? { ...prev, isRunning: false, stopped: true } : null,
    );
    if (listenerRef.current) {
      window.electronAPI.removeListener('local-agent-stream-update', listenerRef.current);
      listenerRef.current = null;
    }
  }, []);

  // --- HTTP path (WKWebView overlay — no IPC) ---
  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const executeViaHttp = useCallback(async (edits: EditItem[]) => {
    stopPolling();
    setExecutionState({ currentStep: 0, totalSteps: edits.length, isRunning: true });

    try {
      await fetch(`${httpBase()}/api/local-agent/execute-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits, manuscriptFilePath }),
      });
    } catch {
      setExecutionState((prev) =>
        prev ? { ...prev, isRunning: false, error: 'Failed to start plan execution' } : null,
      );
      return;
    }

    // Poll execution-status until done
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${httpBase()}/api/local-agent/execution-status`);
        const state: ExecutionState = await res.json();
        setExecutionState(state);
        if (!state.isRunning) stopPolling();
      } catch {
        // Ignore transient fetch errors during polling
      }
    }, 500);
  }, [manuscriptFilePath, stopPolling]);

  const stopViaHttp = useCallback(async () => {
    stopPolling();
    setExecutionState((prev) =>
      prev ? { ...prev, isRunning: false, stopped: true } : null,
    );
    fetch(`${httpBase()}/api/local-agent/stop-plan`, { method: 'POST' }).catch(() => {});
  }, [stopPolling]);

  // --- Unified interface ---
  const execute = useCallback(async (edits: EditItem[]) => {
    if (hasIpc()) {
      await executeViaIpc(edits);
    } else {
      await executeViaHttp(edits);
    }
  }, [executeViaIpc, executeViaHttp]);

  const stop = useCallback(() => {
    if (hasIpc()) {
      stopViaIpc();
    } else {
      stopViaHttp();
    }
  }, [stopViaIpc, stopViaHttp]);

  const reset = useCallback(() => {
    stopPolling();
    setExecutionState(null);
  }, [stopPolling]);

  return { executionState, execute, stop, reset };
}
