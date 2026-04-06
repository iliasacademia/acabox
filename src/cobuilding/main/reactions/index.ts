import log from 'electron-log';
import { SessionAccumulator } from './sessionAccumulator';
import { startServer, stopServer } from './server';

let accumulator: SessionAccumulator | null = null;

export async function startReactions(): Promise<void> {
  try {
    accumulator = new SessionAccumulator();
    await startServer(accumulator);
    log.info('[Reactions] Started successfully');
  } catch (err) {
    log.error('[Reactions] Failed to start:', err);
  }
}

export async function stopReactions(): Promise<void> {
  accumulator = null;
  await stopServer();
  log.info('[Reactions] Stopped');
}
