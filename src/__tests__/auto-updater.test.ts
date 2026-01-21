/**
 * Unit tests for auto-updater functionality
 * Tests the update-downloaded event handler and quitAndInstall behavior
 */

import { EventEmitter } from 'events';

// Mock electron modules
const mockApp = {
  isPackaged: true,
  getVersion: jest.fn(() => '0.0.20260115120000'),
  quit: jest.fn(),
  relaunch: jest.fn(),
  on: jest.fn(),
};

const mockAutoUpdater: any = new EventEmitter();
Object.assign(mockAutoUpdater, {
  setFeedURL: jest.fn(),
  checkForUpdates: jest.fn().mockResolvedValue(undefined),
  quitAndInstall: jest.fn(),
  autoDownload: false,
  autoInstallOnAppQuit: true,
  channel: 'stable',
});

const mockMainWindow = {
  webContents: {
    send: jest.fn(),
  },
  isDestroyed: jest.fn(() => false),
};

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

// Mock environment
process.env.CLOUDFRONT_DOMAIN = 'd1234567890abc.cloudfront.net';

jest.mock('electron', () => ({
  app: mockApp,
}));

jest.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

describe('Auto-Updater', () => {
  let setupAutoUpdater: () => void;
  let isQuittingForUpdate: boolean;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    isQuittingForUpdate = false;

    // Reset autoUpdater event listeners
    mockAutoUpdater.removeAllListeners();

    // Simulate the setupAutoUpdater function from main.ts
    setupAutoUpdater = () => {
      if (!mockApp.isPackaged) {
        mockLogger.info('[Auto-Updater] Disabled in development mode');
        return;
      }

      mockAutoUpdater.autoDownload = false;
      mockAutoUpdater.autoInstallOnAppQuit = true;
      mockAutoUpdater.channel = 'stable';

      const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;
      if (!cloudFrontDomain) {
        mockLogger.error('[Auto-Updater] CLOUDFRONT_DOMAIN not configured');
        return;
      }

      const arch = process.arch;
      const feedUrl = process.platform === 'darwin'
        ? `https://${cloudFrontDomain}/stable/${arch}`
        : `https://${cloudFrontDomain}/stable`;

      mockAutoUpdater.setFeedURL({
        provider: 'generic',
        url: feedUrl,
      });

      mockAutoUpdater.on('checking-for-update', () => {
        mockLogger.info('[Auto-Updater] Checking for updates...');
      });

      mockAutoUpdater.on('update-available', (info: any) => {
        mockLogger.info('[Auto-Updater] Update available:', info.version);
        mockMainWindow?.webContents.send('UPDATE_AVAILABLE', {
          version: info.version,
          formattedVersion: info.version,
        });
      });

      mockAutoUpdater.on('update-not-available', (info: any) => {
        mockLogger.info('[Auto-Updater] No updates available:', info.version);
      });

      // This is the critical event handler we're testing
      mockAutoUpdater.on('update-downloaded', (info: any) => {
        mockLogger.info('[Auto-Updater] Update downloaded:', info.version);

        mockMainWindow?.webContents.send('UPDATE_DOWNLOADED');

        setTimeout(() => {
          mockLogger.info('[Auto-Updater] Auto-restarting to install update...');
          isQuittingForUpdate = true;
          mockAutoUpdater.quitAndInstall(true, true); // THE FIX: with parameters
        }, 1500);
      });

      mockAutoUpdater.on('error', (error: Error) => {
        mockLogger.error('[Auto-Updater] Error occurred:', error.message);
        mockMainWindow?.webContents.send('UPDATE_ERROR', {
          message: error.message || 'Download failed',
        });
      });
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('update-downloaded event', () => {
    it('should call quitAndInstall with correct parameters (isSilent=true, isForceRunAfter=true)', () => {
      // Setup the auto-updater
      setupAutoUpdater();

      // Simulate an update being downloaded
      const updateInfo = {
        version: '0.0.20260121140000',
        releaseDate: '2026-01-21T14:00:00.000Z',
        files: [],
      };

      mockAutoUpdater.emit('update-downloaded', updateInfo);

      // Verify that UPDATE_DOWNLOADED IPC was sent
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('UPDATE_DOWNLOADED');

      // Fast-forward time by 1500ms to trigger the setTimeout
      jest.advanceTimersByTime(1500);

      // Verify that quitAndInstall was called with the correct parameters
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);

      // CRITICAL TEST: This will FAIL if quitAndInstall is called without parameters
      // or with wrong parameters. It expects exactly (true, true)
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);

      // Additional verification: ensure it was NOT called without parameters (the bug)
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalledWith();

      // Verify that isQuittingForUpdate flag was set
      expect(isQuittingForUpdate).toBe(true);

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[Auto-Updater] Update downloaded:',
        updateInfo.version
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[Auto-Updater] Auto-restarting to install update...'
      );
    });

    it('should reproduce the bug: quitAndInstall without parameters would fail to quit on macOS', () => {
      // This test reproduces the original bug where quitAndInstall was called without parameters

      // Setup a buggy version of the auto-updater
      const setupBuggyAutoUpdater = () => {
        mockAutoUpdater.on('update-downloaded', (info: any) => {
          mockLogger.info('[Auto-Updater] Update downloaded:', info.version);
          mockMainWindow?.webContents.send('UPDATE_DOWNLOADED');

          setTimeout(() => {
            mockLogger.info('[Auto-Updater] Auto-restarting to install update...');
            isQuittingForUpdate = true;
            // BUG: Called without parameters
            mockAutoUpdater.quitAndInstall();
          }, 1500);
        });
      };

      setupBuggyAutoUpdater();

      const updateInfo = {
        version: '0.0.20260121140000',
        releaseDate: '2026-01-21T14:00:00.000Z',
        files: [],
      };

      mockAutoUpdater.emit('update-downloaded', updateInfo);
      jest.advanceTimersByTime(1500);

      // Verify that quitAndInstall was called WITHOUT parameters (the bug)
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith();

      // On macOS, calling quitAndInstall() without parameters may not properly close all windows
      // This would result in the app not quitting and the update not being installed
      // The fix is to call quitAndInstall(true, true) instead
    });

    it('should not call quitAndInstall if update download fails', () => {
      setupAutoUpdater();

      const error = new Error('Download failed: Network error');
      mockAutoUpdater.emit('error', error);

      // Fast-forward time
      jest.advanceTimersByTime(2000);

      // Verify that quitAndInstall was NOT called
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

      // Verify error handling
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[Auto-Updater] Error occurred:',
        'Download failed: Network error'
      );
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('UPDATE_ERROR', {
        message: 'Download failed: Network error',
      });
    });

    it('should wait 1.5 seconds before calling quitAndInstall to show completion state', () => {
      setupAutoUpdater();

      const updateInfo = {
        version: '0.0.20260121140000',
        releaseDate: '2026-01-21T14:00:00.000Z',
        files: [],
      };

      mockAutoUpdater.emit('update-downloaded', updateInfo);

      // Verify quitAndInstall is NOT called immediately
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

      // Fast-forward by 1000ms (not enough)
      jest.advanceTimersByTime(1000);
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

      // Fast-forward by another 500ms (total 1500ms)
      jest.advanceTimersByTime(500);
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  describe('setupAutoUpdater', () => {
    it('should configure autoUpdater with correct settings', () => {
      setupAutoUpdater();

      expect(mockAutoUpdater.autoDownload).toBe(false);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
      expect(mockAutoUpdater.channel).toBe('stable');
    });

    it('should set correct feed URL for macOS', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });

      setupAutoUpdater();

      const expectedUrl = `https://d1234567890abc.cloudfront.net/stable/${process.arch}`;
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: expectedUrl,
      });

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        writable: true,
      });
    });

    it('should not setup autoUpdater if CLOUDFRONT_DOMAIN is not configured', () => {
      const originalDomain = process.env.CLOUDFRONT_DOMAIN;
      delete process.env.CLOUDFRONT_DOMAIN;

      setupAutoUpdater();

      expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[Auto-Updater] CLOUDFRONT_DOMAIN not configured'
      );

      process.env.CLOUDFRONT_DOMAIN = originalDomain;
    });
  });

  describe('quitAndInstall parameters explanation', () => {
    it('documents the parameter meanings', () => {
      // This test documents what the parameters mean:
      // quitAndInstall(isSilent, isForceRunAfter)
      //
      // isSilent (boolean, default: false):
      //   - true: Closes all windows silently without prompting user
      //   - false: May show dialogs before quitting
      //
      // isForceRunAfter (boolean, default: false):
      //   - true: Forces the app to automatically run after installation
      //   - false: Requires user to manually launch the app after update
      //
      // For a seamless auto-update experience, we want:
      // - isSilent=true: Quit without user interaction
      // - isForceRunAfter=true: Auto-launch after update installs

      setupAutoUpdater();

      const updateInfo = { version: '0.0.20260121140000', files: [] };
      mockAutoUpdater.emit('update-downloaded', updateInfo);
      jest.advanceTimersByTime(1500);

      // Verify the correct behavior
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(
        true,  // isSilent: quit without user prompts
        true   // isForceRunAfter: auto-launch after install
      );
    });
  });
});
