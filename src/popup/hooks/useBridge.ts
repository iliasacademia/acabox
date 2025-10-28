/**
 * React Hooks for Message Bridge
 *
 * Provides easy-to-use React hooks for bidirectional native communication
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import MessageBridge, { Message, MessageHandler } from '../messageBridge';

// Singleton bridge instance
let bridgeInstance: MessageBridge | null = null;

/**
 * Get or create the bridge singleton
 */
export function getBridgeInstance(clientId: string = 'popup-default'): MessageBridge {
  if (!bridgeInstance) {
    bridgeInstance = new MessageBridge(clientId);
  }
  return bridgeInstance;
}

/**
 * Hook: useBridge
 *
 * Returns the bridge instance for direct access
 *
 * @example
 * const bridge = useBridge();
 * const result = await bridge.sendRequest('native', 'action', payload);
 */
export function useBridge(clientId?: string): MessageBridge {
  const [bridge] = useState(() => getBridgeInstance(clientId));
  return bridge;
}

/**
 * Hook: useNativeEvent
 *
 * Register a handler for events from native code
 * Automatically cleans up on unmount
 *
 * @example
 * useNativeEvent('updateContent', (msg) => {
 *   console.log('Received:', msg.payload);
 * });
 */
export function useNativeEvent(action: string, handler: MessageHandler) {
  const bridge = useBridge();
  const handlerRef = useRef(handler);

  // Keep handler ref up to date
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    // Wrapper to call latest handler
    const wrapper: MessageHandler = (msg) => {
      handlerRef.current(msg);
    };

    bridge.on(action, wrapper);

    return () => {
      bridge.off(action);
    };
  }, [bridge, action]);
}

/**
 * Hook: useSendMessage
 *
 * Returns functions for sending events and requests to native
 *
 * @example
 * const { sendEvent, sendRequest, loading, error } = useSendMessage();
 *
 * // Fire-and-forget
 * sendEvent('buttonClick', { action: 'copy' });
 *
 * // Request-response
 * const result = await sendRequest('searchFiles', { query: 'test' });
 */
export function useSendMessage() {
  const bridge = useBridge();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const sendEvent = useCallback((action: string, payload: any = null) => {
    try {
      bridge.sendEvent('native', action, payload);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [bridge]);

  const sendRequest = useCallback(async (
    action: string,
    payload: any = null,
    timeoutMs: number = 5000
  ): Promise<any> => {
    setLoading(true);
    setError(null);

    try {
      const result = await bridge.sendRequest('native', action, payload, timeoutMs);
      return result;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  return { sendEvent, sendRequest, loading, error };
}

/**
 * Hook: useNativeState
 *
 * Syncs a state value with native code
 * Similar to useState but synced bidirectionally
 *
 * @example
 * const [text, setText] = useNativeState<string>('selectedText', '');
 *
 * // Updates from native automatically update local state
 * // You can also set locally and optionally sync back
 */
export function useNativeState<T>(
  key: string,
  initialValue: T,
  syncToNative: boolean = false
): [T, (value: T) => void] {
  const bridge = useBridge();
  const [state, setState] = useState<T>(initialValue);

  // Listen for state updates from native
  useEffect(() => {
    const handler: MessageHandler = (msg) => {
      if (msg.payload?.key === key) {
        setState(msg.payload.value);
      }
    };

    bridge.on('stateUpdate', handler);

    return () => {
      bridge.off('stateUpdate');
    };
  }, [bridge, key]);

  const setValue = useCallback((newValue: T) => {
    setState(newValue);

    // Optionally sync back to native
    if (syncToNative) {
      bridge.sendEvent('native', 'updateState', {
        key,
        value: newValue
      });
    }
  }, [bridge, key, syncToNative]);

  return [state, setValue];
}

/**
 * Hook: useNativeRequest
 *
 * Hook for making a request to native with loading/error states
 * Returns data, loading state, error, and refetch function
 *
 * @example
 * const { data, loading, error, refetch } = useNativeRequest('getUser', { id: 123 });
 *
 * if (loading) return <Spinner />;
 * if (error) return <Error message={error.message} />;
 * return <div>{data.name}</div>;
 */
export function useNativeRequest<T = any>(
  action: string,
  payload: any = null,
  options: {
    immediate?: boolean;
    timeoutMs?: number;
  } = {}
) {
  const { immediate = true, timeoutMs = 5000 } = options;
  const bridge = useBridge();

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(async (customPayload?: any) => {
    setLoading(true);
    setError(null);

    try {
      const result = await bridge.sendRequest(
        'native',
        action,
        customPayload ?? payload,
        timeoutMs
      );
      setData(result);
      return result;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [bridge, action, payload, timeoutMs]);

  useEffect(() => {
    if (immediate) {
      execute();
    }
  }, [immediate, execute]);

  return { data, loading, error, refetch: execute };
}

/**
 * Hook: useBridgeReady
 *
 * Returns whether the bridge is ready for communication
 *
 * @example
 * const isReady = useBridgeReady();
 *
 * if (!isReady) {
 *   return <div>Connecting to native...</div>;
 * }
 */
export function useBridgeReady(): boolean {
  const bridge = useBridge();
  const [isReady, setIsReady] = useState(bridge.isConnected());

  useEffect(() => {
    // Check periodically (bridge sends ready signal automatically)
    const interval = setInterval(() => {
      setIsReady(bridge.isConnected());
    }, 100);

    return () => clearInterval(interval);
  }, [bridge]);

  return isReady;
}

/**
 * Hook: useNativeCallback
 *
 * Creates a callback that sends a request to native
 * Useful for event handlers
 *
 * @example
 * const handleClick = useNativeCallback('buttonClick', (text) => ({
 *   action: 'lookup',
 *   text
 * }));
 *
 * <button onClick={() => handleClick(selectedText)}>Lookup</button>
 */
export function useNativeCallback<TArgs extends any[], TPayload = any>(
  action: string,
  payloadMapper?: (...args: TArgs) => TPayload,
  options: { timeoutMs?: number } = {}
) {
  const bridge = useBridge();
  const { timeoutMs = 5000 } = options;

  return useCallback(async (...args: TArgs) => {
    const payload = payloadMapper ? payloadMapper(...args) : (args[0] ?? null);

    try {
      const result = await bridge.sendRequest('native', action, payload, timeoutMs);
      return result;
    } catch (error) {
      console.error(`Native callback failed: ${action}`, error);
      throw error;
    }
  }, [bridge, action, payloadMapper, timeoutMs]);
}
