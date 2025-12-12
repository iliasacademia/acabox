import React, { createContext, useContext, ReactNode } from 'react';
import { ConversationsApiClient } from '../types/api';

/**
 * React context for providing the API client to components.
 * This enables dependency injection - components use the same interface
 * regardless of whether they're in Electron (IPC) or Web (fetch).
 */
const ApiContext = createContext<ConversationsApiClient | null>(null);

export interface ApiProviderProps {
  /**
   * The API client implementation to use throughout the component tree.
   * Should implement ConversationsApiClient interface.
   */
  client: ConversationsApiClient;
  children: ReactNode;
}

/**
 * Provider component that makes the API client available to all
 * descendant components via the useApiClient hook.
 *
 * @example
 * // Electron app
 * const electronClient = new ElectronApiClient();
 * <ApiProvider client={electronClient}>
 *   <ConversationsPage />
 * </ApiProvider>
 *
 * @example
 * // Web app
 * const webClient = new WebApiClient(baseUrl, getToken);
 * <ApiProvider client={webClient}>
 *   <ConversationsPage />
 * </ApiProvider>
 */
export function ApiProvider({ client, children }: ApiProviderProps) {
  return (
    <ApiContext.Provider value={client}>
      {children}
    </ApiContext.Provider>
  );
}

/**
 * Hook to access the API client from any component within an ApiProvider.
 *
 * @throws Error if used outside of an ApiProvider
 * @returns The ConversationsApiClient instance
 *
 * @example
 * function MyComponent() {
 *   const client = useApiClient();
 *   const handleClick = async () => {
 *     const data = await client.invoke({ method: 'GET', endpoint: '/api/data' });
 *   };
 * }
 */
export function useApiClient(): ConversationsApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error(
      'useApiClient must be used within an ApiProvider. ' +
      'Wrap your component tree with <ApiProvider client={yourClient}>.'
    );
  }
  return client;
}

export { ApiContext };
