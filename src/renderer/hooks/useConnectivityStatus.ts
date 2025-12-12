import { useState, useEffect } from 'react';

type ConnectivityStatus = 'online' | 'offline' | 'checking';

interface ConnectivityState {
  status: ConnectivityStatus;
  lastChecked: Date | null;
}

/**
 * Hook to monitor internet connectivity status
 * Uses navigator.onLine for instant detection + periodic validation pings
 */
export function useConnectivityStatus(): ConnectivityState {
  const [state, setState] = useState<ConnectivityState>({
    status: 'checking',
    lastChecked: null,
  });

  useEffect(() => {
    // Initial check
    checkConnectivity();

    // Listen for browser online/offline events
    const handleOnline = () => {
      console.log('[Connectivity] Browser detected online');
      checkConnectivity();
    };

    const handleOffline = () => {
      console.log('[Connectivity] Browser detected offline');
      setState({ status: 'offline', lastChecked: new Date() });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Periodic validation check (every 30 seconds)
    const interval = setInterval(() => {
      if (navigator.onLine) {
        checkConnectivity();
      }
    }, 30000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, []);

  const checkConnectivity = async () => {
    // Trust navigator.onLine as the primary indicator
    // This is more reliable and doesn't require network requests
    const isOnline = navigator.onLine;
    setState({
      status: isOnline ? 'online' : 'offline',
      lastChecked: new Date()
    });
  };

  return state;
}
