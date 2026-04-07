import log from 'electron-log';

export interface Scheduler {
  start(): void;
  stop(): void;
}

export function createScheduler(onTick: () => Promise<void>): Scheduler {
  let initialTimeout: ReturnType<typeof setTimeout> | null = null;
  let hourlyInterval: ReturnType<typeof setInterval> | null = null;

  async function safeTick(): Promise<void> {
    try {
      await onTick();
    } catch (err) {
      log.error('[HourlySummary] Scheduled tick failed:', err);
    }
  }

  return {
    start() {
      const now = new Date();
      const msUntilNextHour =
        (60 - now.getMinutes()) * 60_000 -
        now.getSeconds() * 1_000 -
        now.getMilliseconds();

      log.info(`[HourlySummary] Next tick in ${Math.round(msUntilNextHour / 1000)}s`);

      initialTimeout = setTimeout(() => {
        initialTimeout = null;
        safeTick();
        hourlyInterval = setInterval(safeTick, 3_600_000);
      }, msUntilNextHour);
    },

    stop() {
      if (initialTimeout) {
        clearTimeout(initialTimeout);
        initialTimeout = null;
      }
      if (hourlyInterval) {
        clearInterval(hourlyInterval);
        hourlyInterval = null;
      }
    },
  };
}
