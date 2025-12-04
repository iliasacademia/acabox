import { useEffect } from 'react';
import { DevToolsLogPayload, ApiLogData, GeneralLogData } from '../../shared/types';

/**
 * Hook that listens for devtools-log events from the main process
 * and outputs them to the browser DevTools console with styled formatting.
 *
 * Supports two log categories:
 * - 'api': API request/response/error logs with method, endpoint, status
 * - 'general': General info/warn/error/debug logs
 */
export function useDevToolsLog(): void {
  useEffect(() => {
    const handleDevToolsLog = (_event: any, payload: DevToolsLogPayload) => {
      const { timestamp, category, level, data } = payload;

      if (category === 'api') {
        const apiData = data as ApiLogData;
        if (apiData.type === 'request') {
          console.log(
            `%c[${timestamp}] [API REQUEST] ${apiData.method} ${apiData.endpoint}`,
            'color: #0645b1; font-weight: bold',
            apiData.requestData || ''
          );
        } else if (apiData.type === 'response') {
          console.log(
            `%c[${timestamp}] [API RESPONSE] ${apiData.method} ${apiData.endpoint} - ${apiData.status} ${apiData.statusText}`,
            'color: #28a745; font-weight: bold',
            apiData.requestData || ''
          );
        } else if (apiData.type === 'error') {
          console.error(
            `%c[${timestamp}] [API ERROR] ${apiData.method} ${apiData.endpoint} - ${apiData.status || 'No status'}`,
            'color: #dc3545; font-weight: bold',
            { url: apiData.url, message: apiData.message, data: apiData.requestData }
          );
        }
      } else if (category === 'general') {
        const generalData = data as GeneralLogData;
        const colors: Record<string, string> = {
          info: '#17a2b8',
          warn: '#ffc107',
          error: '#dc3545',
          debug: '#6c757d',
        };
        const logFn =
          level === 'error' ? console.error :
          level === 'warn' ? console.warn :
          level === 'debug' ? console.debug : console.log;
        logFn(
          `%c[${timestamp}] [${level.toUpperCase()}]`,
          `color: ${colors[level]}; font-weight: bold`,
          ...generalData.message
        );
      }
    };

    window.electronAPI.on('devtools-log', handleDevToolsLog);

    return () => {
      window.electronAPI.removeListener('devtools-log', handleDevToolsLog);
    };
  }, []);
}
