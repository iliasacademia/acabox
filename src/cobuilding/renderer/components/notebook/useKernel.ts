import { useState, useEffect, useRef, useCallback } from 'react';
import { KernelManager, ServerConnection } from '@jupyterlab/services';
import type { IKernelConnection } from '@jupyterlab/services/lib/kernel/kernel';
import type { IIOPubMessage } from '@jupyterlab/services/lib/kernel/messages';
import type { CellOutput } from './types';

export type KernelStatus = 'disconnected' | 'starting' | 'idle' | 'busy' | 'dead';

export function useKernel() {
  const [status, setStatus] = useState<KernelStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
  const [kernelName, setKernelName] = useState('python3');
  const kernelRef = useRef<IKernelConnection | null>(null);
  const managerRef = useRef<KernelManager | null>(null);

  const connect = useCallback(async (name?: string) => {
    const kernelToStart = name ?? kernelName;
    setStatus('starting');
    setError(null);

    try {
      // Step 1: Start the kernel gateway container
      let url = gatewayUrl;
      if (!url) {
        const result = await window.jupyterAPI.startGateway();
        if ('error' in result) {
          setStatus('dead');
          setError((result as { error: string }).error);
          return;
        }
        url = result.url;
        setGatewayUrl(url);
      }

      // Step 2: Shut down any previous kernel
      if (kernelRef.current) {
        try {
          await kernelRef.current.shutdown();
        } catch {
          // ignore
        }
        kernelRef.current.dispose();
        kernelRef.current = null;
      }
      if (managerRef.current) {
        managerRef.current.dispose();
        managerRef.current = null;
      }

      // Step 3: Connect to the kernel gateway
      const serverSettings = ServerConnection.makeSettings({
        baseUrl: url,
        wsUrl: url.replace('http', 'ws'),
      });

      const manager = new KernelManager({ serverSettings });
      managerRef.current = manager;

      await manager.ready;

      // Step 4: Start a new kernel
      const kernel = await manager.startNew({ name: kernelToStart });
      kernelRef.current = kernel;
      if (name) setKernelName(kernelToStart);

      kernel.statusChanged.connect((_, s) => {
        if (s === 'idle') setStatus('idle');
        else if (s === 'busy') setStatus('busy');
        else if (s === 'dead' || s === 'terminating') setStatus('dead');
        else if (s === 'starting' || s === 'restarting') setStatus('starting');
      });

      // Wait for kernel to be ready
      await kernel.info;
      setStatus('idle');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Kernel connection failed:', message);
      setError(message);
      setStatus('dead');
    }
  }, [gatewayUrl, kernelName]);

  const executeCode = useCallback(
    async (
      code: string,
      onOutput: (output: CellOutput) => void,
    ): Promise<number | null> => {
      const kernel = kernelRef.current;
      if (!kernel) return null;

      const future = kernel.requestExecute({ code });

      return new Promise((resolve) => {
        future.onIOPub = (msg: IIOPubMessage) => {
          const msgType = msg.header.msg_type;
          const content = msg.content as Record<string, unknown>;

          if (msgType === 'stream') {
            onOutput({
              output_type: 'stream',
              name: content.name as 'stdout' | 'stderr',
              text: [content.text as string],
            });
          } else if (msgType === 'execute_result') {
            onOutput({
              output_type: 'execute_result',
              data: content.data as Record<string, unknown>,
              metadata: (content.metadata ?? {}) as Record<string, unknown>,
              execution_count: content.execution_count as number,
            });
          } else if (msgType === 'display_data') {
            onOutput({
              output_type: 'display_data',
              data: content.data as Record<string, unknown>,
              metadata: (content.metadata ?? {}) as Record<string, unknown>,
            });
          } else if (msgType === 'error') {
            onOutput({
              output_type: 'error',
              ename: content.ename as string,
              evalue: content.evalue as string,
              traceback: content.traceback as string[],
            });
          }
        };

        future.done.then((reply) => {
          const count = (reply.content as unknown as Record<string, unknown>)
            .execution_count as number | undefined;
          resolve(count ?? null);
        });
      });
    },
    [],
  );

  const interrupt = useCallback(async () => {
    if (kernelRef.current) {
      await kernelRef.current.interrupt();
    }
  }, []);

  const restart = useCallback(async () => {
    if (kernelRef.current) {
      setStatus('starting');
      setError(null);
      try {
        await kernelRef.current.restart();
        await kernelRef.current.info;
        setStatus('idle');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus('dead');
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      if (kernelRef.current) {
        kernelRef.current.shutdown().catch(() => {});
        kernelRef.current.dispose();
      }
      if (managerRef.current) {
        managerRef.current.dispose();
      }
    };
  }, []);

  return {
    status,
    error,
    kernelName,
    connect,
    executeCode,
    interrupt,
    restart,
  };
}
