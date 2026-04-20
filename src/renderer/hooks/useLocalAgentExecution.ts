import { useState, useCallback, useRef, useEffect } from 'react';
import { EditItem } from './usePlanExecution';

export interface PlanToolEvent {
  name: string;
  input: Record<string, unknown>;
  result: string;
  step: number;
  totalSteps: number;
}

export interface LocalExecState {
  step: number;
  totalSteps: number;
  isRunning: boolean;
  stopped?: boolean;
  error?: string;
  toolEvents: PlanToolEvent[];
}

const hasIpc = () => typeof window !== 'undefined' && 'electronAPI' in window && !!window.electronAPI;

export function useLocalAgentExecution() {
  const [state, setState] = useState<LocalExecState | null>(null);
  const listenerRef = useRef<((event: any, data: any) => void) | null>(null);

  useEffect(() => {
    if (!hasIpc()) return;
    return () => {
      if (listenerRef.current) {
        window.electronAPI.removeListener('local-agent-stream-update', listenerRef.current);
        listenerRef.current = null;
      }
    };
  }, []);

  const startExecution = useCallback(async (edits: EditItem[], manuscriptFilePath: string | null) => {
    if (!hasIpc()) return;

    // Remove previous listener if any
    if (listenerRef.current) {
      window.electronAPI.removeListener('local-agent-stream-update', listenerRef.current);
    }

    setState({ step: 0, totalSteps: edits.length, isRunning: true, toolEvents: [] });

    const listener = (_event: any, data: any) => {
      if (!data.plan_execution) return;

      if (data.plan_tool_call) {
        // Tool call event from runSingleEditLoop
        setState((prev) => prev ? {
          ...prev,
          step: data.step ?? prev.step,
          totalSteps: data.totalSteps ?? prev.totalSteps,
          toolEvents: [...prev.toolEvents, data.plan_tool_call as PlanToolEvent],
        } : null);
      } else if (data.is_final) {
        setState((prev) => prev ? {
          ...prev,
          step: data.stopped ? prev.step : (data.totalSteps as number ?? prev.totalSteps),
          isRunning: false,
          stopped: data.stopped as boolean | undefined,
          error: data.error as string | undefined,
        } : null);
        window.electronAPI.removeListener('local-agent-stream-update', listener);
        listenerRef.current = null;
      } else {
        // Step progress update
        setState((prev) => prev ? {
          ...prev,
          step: data.step as number ?? prev.step,
          totalSteps: data.totalSteps as number ?? prev.totalSteps,
        } : null);
      }
    };

    listenerRef.current = listener;
    window.electronAPI.on('local-agent-stream-update', listener);

    // Fire-and-forget — events stream in via the listener above
    window.electronAPI.invoke('local-agent-execute-plan', {
      edits,
      manuscriptFilePath,
    }).catch(() => {});
  }, []);

  const stopExecution = useCallback(() => {
    if (!hasIpc()) return;
    // Plan execution uses key -1 in activeLoops
    window.electronAPI.invoke('local-agent-stop', -1).catch(() => {});
    setState((prev) => prev ? { ...prev, isRunning: false, stopped: true } : null);
    if (listenerRef.current) {
      window.electronAPI.removeListener('local-agent-stream-update', listenerRef.current);
      listenerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (listenerRef.current) {
      window.electronAPI.removeListener('local-agent-stream-update', listenerRef.current);
      listenerRef.current = null;
    }
    setState(null);
  }, []);

  return { state, startExecution, stopExecution, reset, canUse: hasIpc() };
}
