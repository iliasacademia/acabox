import { defaultLogger as logger } from './utils/logger';

/**
 * Type-safe remote feature flag names.
 * Follows the IPC_CHANNELS pattern in src/shared/types.ts.
 */
export const REMOTE_FLAGS = {
  VERBOSE_WINDOW_MONITOR_LOGGING: 'verbose_window_monitor_logging',
} as const;

export type RemoteFlagName = (typeof REMOTE_FLAGS)[keyof typeof REMOTE_FLAGS];

/**
 * In-memory remote feature flag store.
 * Flags are not persisted — they reset to off on app restart (safe default).
 * The backend sends flag updates via `desktop_feature_flag_changed` events.
 */
class RemoteFeatureFlagStore {
  private flags: Record<string, boolean> = {};

  /**
   * Get the value of a flag. Returns `false` if unset.
   */
  getFlag(name: string): boolean {
    return this.flags[name] === true;
  }

  /**
   * Merge incoming flags into the store. Only boolean values are accepted;
   * non-boolean values are silently ignored.
   */
  setFlags(incoming: Record<string, boolean>): void {
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value !== 'boolean') {
        continue;
      }
      const previous = this.flags[key];
      if (previous !== value) {
        logger.info('[RemoteFeatureFlags] Flag changed', { flag: key, from: previous ?? false, to: value });
      }
      this.flags[key] = value;
    }
  }

  /**
   * Return a snapshot of all current flags.
   */
  getAllFlags(): Record<string, boolean> {
    return { ...this.flags };
  }
}

export const remoteFeatureFlags = new RemoteFeatureFlagStore();
