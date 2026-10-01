/**
 * @jest-environment node
 *
 * Shared folders are writable unless the user locks them (2026-10-01). Runs
 * against a REAL sqlite database (better-sqlite3 is built for Electron's ABI,
 * which `npm test` uses).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-folderlock-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, isPackaged: false },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { initDatabase, closeDatabase, getDatabase } from '../db/database';
import {
  createWorkspace,
  addWorkspaceDirectory,
  listWorkspaceDirectories,
  updateWorkspaceDirectoryPermission,
} from '../db/workspaceRepository';

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('folder lock defaults', () => {
  beforeAll(() => {
    initDatabase(tmpDir);
    createWorkspace('ws1', 'k');
  });

  it('a newly shared folder is writable', () => {
    addWorkspaceDirectory('d1', 'ws1', '/a/Data', 'Data');
    expect(listWorkspaceDirectories('ws1').find(d => d.id === 'd1')!.read_only).toBe(false);
  });

  it('a lock is an explicit choice and round-trips', () => {
    addWorkspaceDirectory('d2', 'ws1', '/a/Locked', 'Locked', 1);
    updateWorkspaceDirectoryPermission('d2', true);
    expect(listWorkspaceDirectories('ws1').find(d => d.id === 'd2')!.read_only).toBe(true);
    addWorkspaceDirectory('d3', 'ws1', '/a/Explicit', 'Explicit', 2, 'local', null, true);
    expect(listWorkspaceDirectories('ws1').find(d => d.id === 'd3')!.read_only).toBe(true);
  });
});

describe('migration 34', () => {
  it('unlocks every pre-existing row, and only runs once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-folderlock-mig-'));
    // Build a DB, lock a row, rewind to version 33, and let the app migrate it.
    closeDatabase();
    initDatabase(dir);
    createWorkspace('w', 'k');
    getDatabase()
      .prepare("INSERT INTO workspace_directories (id, workspace_id, directory_path, display_name, read_only) VALUES ('x','w','/x','x',1)")
      .run();
    getDatabase().pragma('user_version = 33');
    closeDatabase();

    initDatabase(dir);
    expect(listWorkspaceDirectories('w')[0].read_only).toBe(false);
    expect(getDatabase().pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(34);

    // A lock chosen after the migration survives the next boot.
    updateWorkspaceDirectoryPermission('x', true);
    closeDatabase();
    initDatabase(dir);
    expect(listWorkspaceDirectories('w')[0].read_only).toBe(true);
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
