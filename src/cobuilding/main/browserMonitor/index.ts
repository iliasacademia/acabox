import log from 'electron-log';
import { SessionAccumulator } from './sessionAccumulator';
import { startServer, stopServer } from './server';

let accumulator: SessionAccumulator | null = null;

export async function startBrowserMonitor(): Promise<void> {
  try {
    accumulator = new SessionAccumulator();
    await startServer(accumulator);
    log.info('[Browser Monitor] Started successfully');
  } catch (err) {
    log.error('[Browser Monitor] Failed to start:', err);
  }
}

export async function stopBrowserMonitor(): Promise<void> {
  accumulator = null;
  await stopServer();
  log.info('[Browser Monitor] Stopped');
}

export function isBrowserMonitorRunning(): boolean {
  return accumulator !== null;
}
