import { useState, useEffect, useCallback } from 'react';
import { kernelRegistry, type KernelEntrySnapshot } from './kernelRegistry';
import type { CellOutput } from './types';

export type { KernelStatus } from './kernelRegistry';

export function useKernel(key: string) {
  const [snapshot, setSnapshot] = useState<KernelEntrySnapshot>(
    () => kernelRegistry.get(key) ?? { status: 'disconnected', error: null, kernelName: 'python3' },
  );

  useEffect(() => {
    return kernelRegistry.subscribe(key, setSnapshot);
  }, [key]);

  const connect = useCallback(
    async (name?: string) => {
      await kernelRegistry.connect(key, name);
    },
    [key],
  );

  const executeCode = useCallback(
    (code: string, onOutput: (output: CellOutput) => void): Promise<number | null> => {
      return kernelRegistry.execute(key, code, onOutput);
    },
    [key],
  );

  const interrupt = useCallback(() => kernelRegistry.interrupt(key), [key]);
  const restart = useCallback(() => kernelRegistry.restart(key), [key]);

  return {
    status: snapshot.status,
    error: snapshot.error,
    kernelName: snapshot.kernelName,
    connect,
    executeCode,
    interrupt,
    restart,
  };
}
