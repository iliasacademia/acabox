/**
 * Unit tests for ProjectSyncService
 */

// Mock electron
jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  app: {
    getVersion: jest.fn(() => '1.0.0-test'),
    isPackaged: false,
    getPath: jest.fn(() => '/mock/path'),
  },
}));

// Mock electron-store
jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn().mockReturnValue([]),
    set: jest.fn(),
  }));
});

// Mock chokidar
const mockWatcher = {
  on: jest.fn().mockReturnThis(),
  close: jest.fn().mockResolvedValue(undefined),
  getWatched: jest.fn().mockReturnValue({}),
};
jest.mock('chokidar', () => ({
  watch: jest.fn(() => mockWatcher),
}));

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  statSync: jest.fn(),
  readdirSync: jest.fn(),
  createReadStream: jest.fn(() => 'mock-stream'),
}));

// Mock apiClient
const mockClient: any = {
  get: jest.fn(),
  post: jest.fn(),
};
jest.mock('../apiClient', () => ({
  APIclient: jest.fn(async () => mockClient),
  getCsrfToken: jest.fn(async () => 'mock-csrf-token'),
  checkLogin: jest.fn(),
}));

// Mock form-data
jest.mock('form-data', () => {
  return jest.fn().mockImplementation(() => ({
    append: jest.fn(),
    getHeaders: jest.fn(() => ({ 'content-type': 'multipart/form-data' })),
  }));
});

// Mock checksum
jest.mock('../utils/checksum', () => ({
  calculateChecksum: jest.fn(),
}));

// Mock logger
jest.mock('../utils/logger', () => ({
  defaultLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import * as chokidar from 'chokidar';
import * as fs from 'fs';
import Store from 'electron-store';
import { checkLogin } from '../apiClient';
import { calculateChecksum } from '../utils/checksum';
import {
  ProjectSyncService,
  validatePath,
  getMimeType,
} from '../projectSyncService';

describe('ProjectSyncService', () => {
  let service: ProjectSyncService;
  let mockStore: any;
  let mockWindow: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mockWatcher.on so we get fresh handler registrations per test
    mockWatcher.on.mockReset().mockReturnThis();
    mockWatcher.close.mockReset().mockResolvedValue(undefined);
    mockWatcher.getWatched.mockReset().mockReturnValue({});
    (chokidar.watch as jest.Mock).mockReturnValue(mockWatcher);

    // Fresh service instance per test
    service = new ProjectSyncService();

    // Inject mock store (same pattern as eventsManager.test.ts line 54)
    mockStore = {
      get: jest.fn().mockReturnValue([]),
      set: jest.fn(),
    };
    (service as any)._store = mockStore;

    // Mock window
    mockWindow = {
      webContents: {
        send: jest.fn(),
        isDestroyed: jest.fn().mockReturnValue(false),
      },
      isDestroyed: jest.fn().mockReturnValue(false),
    };
  });

  // =========================================================================
  // Tier 1: Pure functions (zero mocking needed)
  // =========================================================================

  describe('validatePath', () => {
    it('should accept a file within the base directory', () => {
      expect(validatePath('/base/dir', '/base/dir/file.txt')).toBe(true);
    });

    it('should accept a file in a subdirectory', () => {
      expect(validatePath('/base/dir', '/base/dir/sub/file.txt')).toBe(true);
    });

    it('should accept deeply nested paths', () => {
      expect(validatePath('/base', '/base/a/b/c/d/file.txt')).toBe(true);
    });

    it('should reject parent traversal with ../', () => {
      expect(validatePath('/base/dir', '/base/dir/../secret.txt')).toBe(false);
    });

    it('should reject sibling directory access', () => {
      expect(validatePath('/base/dir', '/base/other/file.txt')).toBe(false);
    });

    it('should reject absolute paths outside base', () => {
      expect(validatePath('/base/dir', '/etc/passwd')).toBe(false);
    });

    it('should accept the base directory itself', () => {
      expect(validatePath('/base/dir', '/base/dir')).toBe(true);
    });

    it('should handle identical paths', () => {
      expect(validatePath('/base/dir/', '/base/dir/')).toBe(true);
    });
  });

  describe('getMimeType', () => {
    it('should return correct type for .pdf', () => {
      expect(getMimeType('.pdf')).toBe('application/pdf');
    });

    it('should return correct type for .doc', () => {
      expect(getMimeType('.doc')).toBe('application/msword');
    });

    it('should return correct type for .docx', () => {
      expect(getMimeType('.docx')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    });

    it('should return correct type for .txt', () => {
      expect(getMimeType('.txt')).toBe('text/plain');
    });

    it('should return correct type for .md', () => {
      expect(getMimeType('.md')).toBe('text/markdown');
    });

    it('should return correct type for .jpg and .jpeg', () => {
      expect(getMimeType('.jpg')).toBe('image/jpeg');
      expect(getMimeType('.jpeg')).toBe('image/jpeg');
    });

    it('should return correct type for .png', () => {
      expect(getMimeType('.png')).toBe('image/png');
    });

    it('should return correct type for .gif', () => {
      expect(getMimeType('.gif')).toBe('image/gif');
    });

    it('should return correct type for .zip', () => {
      expect(getMimeType('.zip')).toBe('application/zip');
    });

    it('should return application/octet-stream for unknown extensions', () => {
      expect(getMimeType('.xyz')).toBe('application/octet-stream');
      expect(getMimeType('.foo')).toBe('application/octet-stream');
      expect(getMimeType('')).toBe('application/octet-stream');
    });
  });

  // =========================================================================
  // Tier 2: Service lifecycle
  // =========================================================================

  describe('sendToRenderer', () => {
    it('should send when window is valid', () => {
      service.setMainWindow(mockWindow);
      (service as any).sendToRenderer('test-channel', { data: 'test' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('test-channel', { data: 'test' });
    });

    it('should no-op when mainWindow is null', () => {
      service.setMainWindow(null as any);
      (service as any).sendToRenderer('test-channel', { data: 'test' });

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should no-op when window is destroyed', () => {
      mockWindow.isDestroyed.mockReturnValue(true);
      service.setMainWindow(mockWindow);
      (service as any).sendToRenderer('test-channel', { data: 'test' });

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('initialize()', () => {
    it('should skip when user is not logged in', async () => {
      (checkLogin as jest.Mock).mockResolvedValue(false);

      await service.initialize();

      // Should not start any watchers
      expect(chokidar.watch).not.toHaveBeenCalled();
    });

    it('should skip when checkLogin throws', async () => {
      (checkLogin as jest.Mock).mockRejectedValue(new Error('network error'));

      await service.initialize();

      // Should handle error gracefully and not crash
      expect(chokidar.watch).not.toHaveBeenCalled();
    });

    it('should restore valid folders from persisted state', async () => {
      (checkLogin as jest.Mock).mockResolvedValue(true);
      mockStore.get
        .mockReturnValueOnce([
          { projectId: 1, folderId: 10, folderPath: '/valid/folder' },
        ])
        .mockReturnValueOnce([]); // files
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockClient.get.mockResolvedValue({ data: { projects: [] } });

      await service.initialize();

      expect(chokidar.watch).toHaveBeenCalledWith(
        '/valid/folder',
        expect.any(Object)
      );
    });

    it('should prune missing folders from persisted state', async () => {
      (checkLogin as jest.Mock).mockResolvedValue(true);
      mockStore.get
        .mockReturnValueOnce([
          { projectId: 1, folderId: 10, folderPath: '/missing/folder' },
          { projectId: 2, folderId: 20, folderPath: '/valid/folder' },
        ])
        .mockReturnValueOnce([]); // files
      (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/valid/folder');
      mockClient.get.mockResolvedValue({ data: { projects: [] } });

      await service.initialize();

      // Should update persisted state to only include valid folder
      expect(mockStore.set).toHaveBeenCalledWith(
        'folders',
        [{ projectId: 2, folderId: 20, folderPath: '/valid/folder' }]
      );
    });

    it('should handle per-folder errors gracefully and continue', async () => {
      (checkLogin as jest.Mock).mockResolvedValue(true);
      mockStore.get
        .mockReturnValueOnce([
          { projectId: 1, folderId: 10, folderPath: '/folder1' },
          { projectId: 2, folderId: 20, folderPath: '/folder2' },
        ])
        .mockReturnValueOnce([]); // files
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // First watch call throws, second succeeds
      (chokidar.watch as jest.Mock)
        .mockImplementationOnce(() => { throw new Error('watch error'); })
        .mockReturnValueOnce(mockWatcher);

      mockClient.get.mockResolvedValue({ data: { projects: [] } });

      await service.initialize();

      // Should still try the second folder
      expect(chokidar.watch).toHaveBeenCalledTimes(2);
    });

    it('should restore standalone files from persisted state', async () => {
      (checkLogin as jest.Mock).mockResolvedValue(true);
      mockStore.get
        .mockReturnValueOnce([]) // folders
        .mockReturnValueOnce([
          { projectId: 1, filePath: '/valid/file.pdf' },
        ]); // files
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockClient.get.mockResolvedValue({ data: { projects: [] } });

      await service.initialize();

      expect(chokidar.watch).toHaveBeenCalledWith(
        '/valid/file.pdf',
        expect.any(Object)
      );
    });

    it('should prune missing files from persisted state', async () => {
      (checkLogin as jest.Mock).mockResolvedValue(true);
      mockStore.get
        .mockReturnValueOnce([]) // folders
        .mockReturnValueOnce([
          { projectId: 1, filePath: '/missing/file.pdf' },
        ]); // files
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      mockClient.get.mockResolvedValue({ data: { projects: [] } });

      await service.initialize();

      expect(mockStore.set).toHaveBeenCalledWith('files', []);
    });
  });

  describe('startWatching()', () => {
    it('should reject when folder does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await expect(service.startWatching(1, 10, '/no/folder')).rejects.toThrow(
        'Folder does not exist'
      );
    });

    it('should skip duplicate watchers', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await service.startWatching(1, 10, '/test/folder');

      // Reset mock to track second call
      (chokidar.watch as jest.Mock).mockClear();
      await service.startWatching(1, 10, '/test/folder');

      // Should not create a second watcher
      expect(chokidar.watch).not.toHaveBeenCalled();
    });

    it('should create chokidar watcher and persist state', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await service.startWatching(1, 10, '/test/folder');

      expect(chokidar.watch).toHaveBeenCalledWith(
        '/test/folder',
        expect.objectContaining({
          persistent: true,
          ignoreInitial: true,
        })
      );
      expect(mockStore.set).toHaveBeenCalledWith('folders', expect.any(Array));
    });

    it('should register event handlers on watcher', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await service.startWatching(1, 10, '/test/folder');

      const registeredEvents = mockWatcher.on.mock.calls.map(
        (call: any[]) => call[0]
      );
      expect(registeredEvents).toContain('add');
      expect(registeredEvents).toContain('change');
      expect(registeredEvents).toContain('unlink');
      expect(registeredEvents).toContain('ready');
      expect(registeredEvents).toContain('error');
    });

    it('should update manuscriptPath on duplicate watcher when provided', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await service.startWatching(1, 10, '/test/folder');
      await service.startWatching(1, 10, '/test/folder', '/test/folder/paper.docx');

      // Should persist updated state with manuscript path
      expect(mockStore.set).toHaveBeenCalledWith('folders', expect.arrayContaining([
        expect.objectContaining({ manuscriptPath: '/test/folder/paper.docx' }),
      ]));
    });
  });

  describe('stopWatching()', () => {
    it('should close watcher and clean up', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await service.startWatching(1, 10, '/test/folder');
      await service.stopWatching(1, 10);

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(service.getWatcherStatus(1, 10)).toBeNull();
    });

    it('should persist state after stopping', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await service.startWatching(1, 10, '/test/folder');
      mockStore.set.mockClear();

      await service.stopWatching(1, 10);

      expect(mockStore.set).toHaveBeenCalledWith('folders', []);
    });

    it('should send watcher status changed event', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      service.setMainWindow(mockWindow);
      await service.startWatching(1, 10, '/test/folder');
      await service.stopWatching(1, 10);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'project-watcher-status-changed',
        expect.objectContaining({
          projectId: 1,
          folderId: 10,
          watcherActive: false,
        })
      );
    });

    it('should no-op when folder is not being watched', async () => {
      // Should not throw
      await service.stopWatching(999, 999);
      expect(mockWatcher.close).not.toHaveBeenCalled();
    });
  });

  describe('startWatchingFile()', () => {
    it('should reject when file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await expect(
        service.startWatchingFile(1, '/no/file.pdf')
      ).rejects.toThrow('File does not exist');
    });

    it('should skip duplicate file watchers', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await service.startWatchingFile(1, '/test/file.pdf');

      (chokidar.watch as jest.Mock).mockClear();
      await service.startWatchingFile(1, '/test/file.pdf');

      // Should not create a second watcher
      expect(chokidar.watch).not.toHaveBeenCalled();
    });

    it('should create watcher, upload, and persist state', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await service.startWatchingFile(1, '/test/file.pdf');

      expect(chokidar.watch).toHaveBeenCalledWith(
        '/test/file.pdf',
        expect.any(Object)
      );
      expect(mockClient.post).toHaveBeenCalled();
      expect(mockStore.set).toHaveBeenCalledWith('files', expect.any(Array));
    });

    it('should notify renderer about initial sync', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      service.setMainWindow(mockWindow);
      await service.startWatchingFile(1, '/test/file.pdf');

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'project-file-synced',
        expect.objectContaining({
          projectId: 1,
          filePath: 'file.pdf',
          action: 'initial-sync',
        })
      );
    });
  });

  describe('stopWatchingFile()', () => {
    it('should close watcher and clean up', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await service.startWatchingFile(1, '/test/file.pdf');
      await service.stopWatchingFile(1, '/test/file.pdf');

      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('should persist state after stopping', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await service.startWatchingFile(1, '/test/file.pdf');
      mockStore.set.mockClear();

      await service.stopWatchingFile(1, '/test/file.pdf');

      expect(mockStore.set).toHaveBeenCalledWith('files', []);
    });

    it('should no-op when file is not being watched', async () => {
      await service.stopWatchingFile(999, '/no/file.pdf');
      expect(mockWatcher.close).not.toHaveBeenCalled();
    });
  });

  describe('stopWatchingProject()', () => {
    it('should stop both folder and file watchers for a project', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await service.startWatching(1, 10, '/test/folder');
      await service.startWatchingFile(1, '/test/file.pdf');

      await service.stopWatchingProject(1);

      expect(service.getWatcherStatus(1, 10)).toBeNull();
      expect(service.getAllWatchedFolders()).toHaveLength(0);
    });
  });

  describe('getWatcherStatus()', () => {
    it('should return null for unwatched folder', () => {
      expect(service.getWatcherStatus(999, 999)).toBeNull();
    });

    it('should return status for watched folder', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await service.startWatching(1, 10, '/test/folder');

      const status = service.getWatcherStatus(1, 10);
      expect(status).not.toBeNull();
      expect(status!.watcherActive).toBe(true);
    });
  });

  describe('persistState()', () => {
    it('should persist both folders and files', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await service.startWatching(1, 10, '/test/folder');
      await service.startWatchingFile(2, '/test/file.pdf');

      expect(mockStore.set).toHaveBeenCalledWith('folders', expect.arrayContaining([
        expect.objectContaining({ projectId: 1, folderId: 10 }),
      ]));
      expect(mockStore.set).toHaveBeenCalledWith('files', expect.arrayContaining([
        expect.objectContaining({ projectId: 2, filePath: '/test/file.pdf' }),
      ]));
    });
  });

  // =========================================================================
  // Tier 3: Sync operations
  // =========================================================================

  describe('performStartupSyncForFile()', () => {
    beforeEach(() => {
      // Set up a watched file entry so performStartupSyncForFile doesn't bail early
      (service as any).watchedFiles.set('1-/test/file.pdf', {
        projectId: 1,
        filePath: '/test/file.pdf',
        watcher: mockWatcher,
        status: 'idle',
        lastSync: null,
      });
    });

    it('should upload when file not on backend', async () => {
      mockClient.get.mockResolvedValue({ data: { files: [] } });
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await (service as any).performStartupSyncForFile(1, '/test/file.pdf');

      expect(mockClient.post).toHaveBeenCalled();
      const watchedFile = (service as any).watchedFiles.get('1-/test/file.pdf');
      expect(watchedFile.status).toBe('synced');
    });

    it('should re-upload when checksum mismatches', async () => {
      mockClient.get.mockResolvedValue({
        data: { files: [{ file_path: 'file.pdf', checksum: 'remote-hash' }] },
      });
      (calculateChecksum as jest.Mock).mockResolvedValue('local-hash');
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await (service as any).performStartupSyncForFile(1, '/test/file.pdf');

      expect(mockClient.post).toHaveBeenCalled();
    });

    it('should skip upload when checksums match', async () => {
      mockClient.get.mockResolvedValue({
        data: { files: [{ file_path: 'file.pdf', checksum: 'same-hash' }] },
      });
      (calculateChecksum as jest.Mock).mockResolvedValue('same-hash');

      await (service as any).performStartupSyncForFile(1, '/test/file.pdf');

      expect(mockClient.post).not.toHaveBeenCalled();
      const watchedFile = (service as any).watchedFiles.get('1-/test/file.pdf');
      expect(watchedFile.status).toBe('synced');
    });

    it('should stop watcher on 404 from API GET (project deleted)', async () => {
      const error = new Error('Not found');
      (error as any).response = { status: 404 };
      mockClient.get.mockRejectedValue(error);

      await (service as any).performStartupSyncForFile(1, '/test/file.pdf');

      // Should have removed the watched file
      expect((service as any).watchedFiles.has('1-/test/file.pdf')).toBe(false);
    });

    it('should stop watcher on 404 from syncStandaloneFile (project deleted)', async () => {
      // GET succeeds (file not on backend), but POST returns 404
      mockClient.get.mockResolvedValue({ data: { files: [] } });
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockClient.post.mockResolvedValue({
        status: 404,
        data: { errors: ['Project not found'] },
      });

      await (service as any).performStartupSyncForFile(1, '/test/file.pdf');

      // Should have removed the watched file
      expect((service as any).watchedFiles.has('1-/test/file.pdf')).toBe(false);
    });

    it('should set error status on other errors', async () => {
      mockClient.get.mockRejectedValue(new Error('server error'));

      await (service as any).performStartupSyncForFile(1, '/test/file.pdf');

      const watchedFile = (service as any).watchedFiles.get('1-/test/file.pdf');
      expect(watchedFile.status).toBe('error');
    });
  });

  describe('performStartupSync() - 404 detection', () => {
    beforeEach(async () => {
      // Set up a watched folder so performStartupSync doesn't bail early
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['file.pdf']);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 1024, isDirectory: () => false, isFile: () => true });

      await service.startWatching(1, 10, '/test/folder');
      service.setMainWindow(mockWindow);
      mockWatcher.close.mockClear();
      mockStore.set.mockClear();
      mockWindow.webContents.send.mockClear();
    });

    it('should stop watcher when syncFileToProject returns 404', async () => {
      // getAllFiles returns one file
      (fs.readdirSync as jest.Mock).mockReturnValue([{ name: 'file.pdf', isDirectory: () => false, isFile: () => true }]);
      jest.spyOn(service as any, 'getAllFiles').mockReturnValue(['/test/folder/file.pdf']);

      // Backend says file is new (not in file list)
      mockClient.get.mockResolvedValue({ data: { files: [] } });

      // syncFileToProject POST returns 404
      mockClient.post.mockResolvedValue({
        status: 404,
        data: { errors: ['Project not found'] },
      });

      await (service as any).performStartupSync(1, 10, '/test/folder');

      // Watcher should have been stopped and cleaned up
      expect(mockWatcher.close).toHaveBeenCalled();
      expect(service.getWatcherStatus(1, 10)).toBeNull();
    });

    it('should not stop watcher on non-404 sync errors', async () => {
      jest.spyOn(service as any, 'getAllFiles').mockReturnValue(['/test/folder/file.pdf']);

      // Backend says file is new
      mockClient.get.mockResolvedValue({ data: { files: [] } });

      // syncFileToProject POST returns 500
      mockClient.post.mockResolvedValue({
        status: 500,
        data: { error: 'internal server error' },
      });

      await (service as any).performStartupSync(1, 10, '/test/folder');

      // Watcher should still be active (not cleaned up)
      expect(service.getWatcherStatus(1, 10)).not.toBeNull();
    });
  });

  describe('performStartupFileSync() - 404 detection', () => {
    beforeEach(async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['file.pdf']);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 1024 });

      // Start watching to create the folder entry
      await service.startWatching(1, 10, '/test/folder');
      service.setMainWindow(mockWindow);
      mockWatcher.close.mockClear();
      mockStore.set.mockClear();
      mockWindow.webContents.send.mockClear();
    });

    it('should stop watcher on 404 from API GET', async () => {
      const error = new Error('Not found');
      (error as any).response = { status: 404 };
      mockClient.get.mockRejectedValue(error);

      await (service as any).performStartupFileSync(1, 10, '/test/folder', '/test/folder/file.pdf');

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(service.getWatcherStatus(1, 10)).toBeNull();
    });

    it('should stop watcher on 404 from syncFileToProject', async () => {
      // API GET succeeds, file not on backend -> triggers upload
      mockClient.get.mockResolvedValue({ data: { files: [] } });

      // syncFileToProject POST returns 404
      mockClient.post.mockResolvedValue({
        status: 404,
        data: { errors: ['Project not found'] },
      });

      await (service as any).performStartupFileSync(1, 10, '/test/folder', '/test/folder/file.pdf');

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(service.getWatcherStatus(1, 10)).toBeNull();
    });

    it('should not stop watcher on non-404 errors', async () => {
      mockClient.get.mockRejectedValue(new Error('network error'));

      await (service as any).performStartupFileSync(1, 10, '/test/folder', '/test/folder/file.pdf');

      // Watcher should still exist (error status, but not cleaned up)
      expect(service.getWatcherStatus(1, 10)).not.toBeNull();
    });
  });

  describe('syncStandaloneFile()', () => {
    it('should validate file size limit', async () => {
      const hugeSize = 600 * 1024 * 1024;
      (fs.statSync as jest.Mock).mockReturnValue({ size: hugeSize });

      await expect(
        (service as any).syncStandaloneFile(1, '/test/huge.pdf')
      ).rejects.toThrow('File too large');
    });

    it('should send correct FormData fields', async () => {
      (fs.statSync as jest.Mock).mockReturnValue({ size: 1024 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      await (service as any).syncStandaloneFile(1, '/test/paper.pdf');

      // Verify the API was called with the correct endpoint
      expect(mockClient.post).toHaveBeenCalledWith(
        'v0/co_scientist/projects/1/files',
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-csrf-token': 'mock-csrf-token',
          }),
        })
      );
    });

    it('should throw on non-2xx response', async () => {
      (fs.statSync as jest.Mock).mockReturnValue({ size: 1024 });
      mockClient.post.mockResolvedValue({
        status: 500,
        data: { error: 'internal' },
      });

      await expect(
        (service as any).syncStandaloneFile(1, '/test/paper.pdf')
      ).rejects.toThrow('Failed to sync standalone file');
    });

    it('should attach HTTP status to thrown error on non-2xx response', async () => {
      (fs.statSync as jest.Mock).mockReturnValue({ size: 1024 });
      mockClient.post.mockResolvedValue({
        status: 404,
        data: { errors: ['Project not found'] },
      });

      try {
        await (service as any).syncStandaloneFile(1, '/test/paper.pdf');
        fail('Expected error to be thrown');
      } catch (error: any) {
        expect(error.status).toBe(404);
        expect(error.message).toContain('Failed to sync standalone file');
      }
    });
  });

  describe('syncFileToProject()', () => {
    it('should attach HTTP status to thrown error on non-2xx response', async () => {
      (fs.statSync as jest.Mock).mockReturnValue({ size: 1024 });
      mockClient.post.mockResolvedValue({
        status: 404,
        data: { errors: ['Project not found'] },
      });

      try {
        await (service as any).syncFileToProject(1, 10, '/test/folder', '/test/folder/file.pdf');
        fail('Expected error to be thrown');
      } catch (error: any) {
        expect(error.status).toBe(404);
        expect(error.message).toContain('Failed to sync file');
      }
    });
  });

  describe('chokidar event handlers (standalone file)', () => {
    beforeEach(async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      service.setMainWindow(mockWindow);
      await service.startWatchingFile(1, '/test/file.pdf');

      // Clear mocks so we only track handler-triggered calls
      mockClient.post.mockClear();
      mockWindow.webContents.send.mockClear();
    });

    it('should sync file on change event', async () => {
      (fs.statSync as jest.Mock).mockReturnValue({ size: 200 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      // Find the 'change' handler
      const changeCall = mockWatcher.on.mock.calls.find(
        (call: any[]) => call[0] === 'change'
      );
      expect(changeCall).toBeDefined();

      // Trigger the change handler
      await changeCall![1]();

      expect(mockClient.post).toHaveBeenCalled();
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'project-file-synced',
        expect.objectContaining({
          projectId: 1,
          action: 'changed',
        })
      );
    });

    it('should send delete event on unlink', () => {
      const unlinkCall = mockWatcher.on.mock.calls.find(
        (call: any[]) => call[0] === 'unlink'
      );
      expect(unlinkCall).toBeDefined();

      unlinkCall![1]();

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'project-file-synced',
        expect.objectContaining({
          projectId: 1,
          action: 'deleted',
        })
      );
    });

    it('should set error status on change sync failure', async () => {
      mockClient.post.mockResolvedValue({ status: 500, data: { error: 'fail' } });

      const changeCall = mockWatcher.on.mock.calls.find(
        (call: any[]) => call[0] === 'change'
      );

      await changeCall![1]();

      const watchedFile = (service as any).watchedFiles.get('1-/test/file.pdf');
      expect(watchedFile.status).toBe('error');
    });
  });

  describe('chokidar event handlers (folder watcher)', () => {
    beforeEach(async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      service.setMainWindow(mockWindow);
      await service.startWatching(1, 10, '/test/folder');

      mockWindow.webContents.send.mockClear();
    });

    it('should sync file on add event', async () => {
      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });
      mockClient.post.mockResolvedValue({ status: 200, data: { uploaded: true } });

      // Call handleFileAdded directly since the watcher's 'add' handler is fire-and-forget
      await (service as any).handleFileAdded(1, 10, '/test/folder', '/test/folder/new-file.txt');

      expect(mockClient.post).toHaveBeenCalled();
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'project-file-synced',
        expect.objectContaining({
          projectId: 1,
          folderId: 10,
          action: 'added',
        })
      );
    });

    it('should send delete event on unlink', () => {
      const unlinkCall = mockWatcher.on.mock.calls.find(
        (call: any[]) => call[0] === 'unlink'
      );
      expect(unlinkCall).toBeDefined();

      unlinkCall![1]('/test/folder/deleted-file.txt');

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'project-file-synced',
        expect.objectContaining({
          projectId: 1,
          folderId: 10,
          action: 'deleted',
        })
      );
    });

    it('should broadcast watcher active on ready event', () => {
      const readyCall = mockWatcher.on.mock.calls.find(
        (call: any[]) => call[0] === 'ready'
      );
      expect(readyCall).toBeDefined();

      readyCall![1]();

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'project-watcher-status-changed',
        expect.objectContaining({
          projectId: 1,
          folderId: 10,
          watcherActive: true,
        })
      );
    });

    it('should set error status and broadcast on watcher error', () => {
      const errorCall = mockWatcher.on.mock.calls.find(
        (call: any[]) => call[0] === 'error'
      );
      expect(errorCall).toBeDefined();

      errorCall![1](new Error('watch failed'));

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'project-watcher-status-changed',
        expect.objectContaining({
          projectId: 1,
          folderId: 10,
          watcherActive: false,
          status: 'error',
        })
      );
    });
  });

  describe('updateManuscriptPath()', () => {
    it('should update manuscript path for all folders of a project', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      await service.startWatching(1, 10, '/test/folder');
      mockStore.set.mockClear();

      service.updateManuscriptPath(1, '/test/folder/paper.docx');

      expect(mockStore.set).toHaveBeenCalledWith('folders', expect.arrayContaining([
        expect.objectContaining({ manuscriptPath: '/test/folder/paper.docx' }),
      ]));
    });

    it('should not persist if no matching project found', () => {
      mockStore.set.mockClear();
      service.updateManuscriptPath(999, '/test/paper.docx');
      expect(mockStore.set).not.toHaveBeenCalled();
    });
  });
});
