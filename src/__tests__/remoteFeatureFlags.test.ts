// Mock electron so logger can initialize
jest.mock('electron', () => ({
  app: {
    getVersion: jest.fn(() => '1.0.0-test'),
    isPackaged: false,
    getPath: jest.fn(() => '/mock/path'),
  },
  BrowserWindow: jest.fn(),
}));

import { remoteFeatureFlags, REMOTE_FLAGS } from '../remoteFeatureFlags';

describe('RemoteFeatureFlagStore', () => {
  beforeEach(() => {
    // Reset flags by setting all known flags to false, then clear via internal access
    (remoteFeatureFlags as any).flags = {};
  });

  describe('getFlag', () => {
    it('should return false for unset flags', () => {
      expect(remoteFeatureFlags.getFlag('nonexistent_flag')).toBe(false);
    });

    it('should return false for known flags that have not been set', () => {
      expect(remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)).toBe(false);
    });
  });

  describe('setFlags', () => {
    it('should set and get flags correctly', () => {
      remoteFeatureFlags.setFlags({ verbose_window_monitor_logging: true });
      expect(remoteFeatureFlags.getFlag('verbose_window_monitor_logging')).toBe(true);
    });

    it('should set flags to false', () => {
      remoteFeatureFlags.setFlags({ verbose_window_monitor_logging: true });
      remoteFeatureFlags.setFlags({ verbose_window_monitor_logging: false });
      expect(remoteFeatureFlags.getFlag('verbose_window_monitor_logging')).toBe(false);
    });

    it('should merge multiple flags', () => {
      remoteFeatureFlags.setFlags({ flag_a: true, flag_b: false });
      expect(remoteFeatureFlags.getFlag('flag_a')).toBe(true);
      expect(remoteFeatureFlags.getFlag('flag_b')).toBe(false);
    });

    it('should merge across multiple calls without overwriting unmentioned flags', () => {
      remoteFeatureFlags.setFlags({ flag_a: true });
      remoteFeatureFlags.setFlags({ flag_b: true });
      expect(remoteFeatureFlags.getFlag('flag_a')).toBe(true);
      expect(remoteFeatureFlags.getFlag('flag_b')).toBe(true);
    });

    it('should ignore non-boolean values', () => {
      remoteFeatureFlags.setFlags({
        good_flag: true,
        string_flag: 'yes' as any,
        number_flag: 1 as any,
        null_flag: null as any,
        undefined_flag: undefined as any,
      });
      expect(remoteFeatureFlags.getFlag('good_flag')).toBe(true);
      expect(remoteFeatureFlags.getFlag('string_flag')).toBe(false);
      expect(remoteFeatureFlags.getFlag('number_flag')).toBe(false);
      expect(remoteFeatureFlags.getFlag('null_flag')).toBe(false);
      expect(remoteFeatureFlags.getFlag('undefined_flag')).toBe(false);
    });
  });

  describe('getAllFlags', () => {
    it('should return empty object when no flags are set', () => {
      expect(remoteFeatureFlags.getAllFlags()).toEqual({});
    });

    it('should return a snapshot of all flags', () => {
      remoteFeatureFlags.setFlags({ flag_a: true, flag_b: false });
      const snapshot = remoteFeatureFlags.getAllFlags();
      expect(snapshot).toEqual({ flag_a: true, flag_b: false });
    });

    it('should return a copy (not a reference to internal state)', () => {
      remoteFeatureFlags.setFlags({ flag_a: true });
      const snapshot = remoteFeatureFlags.getAllFlags();
      snapshot.flag_a = false;
      expect(remoteFeatureFlags.getFlag('flag_a')).toBe(true);
    });
  });

  describe('REMOTE_FLAGS constants', () => {
    it('should have VERBOSE_WINDOW_MONITOR_LOGGING', () => {
      expect(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING).toBe('verbose_window_monitor_logging');
    });
  });
});
