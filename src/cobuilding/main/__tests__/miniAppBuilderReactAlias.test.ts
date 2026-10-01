/**
 * @jest-environment node
 *
 * T06 — every tool bundle resolves react / react-dom to the npm-site's single
 * copy, only when those directories exist.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/nonexistent-userdata' },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../containerService', () => ({
  containerService: { execLogged: jest.fn() },
}));
jest.mock('../buildHealth', () => ({
  recordBuildResult: jest.fn(),
}));

import { reactAliasFlags } from '../miniAppBuilder';

describe('miniAppBuilder — React alias flags (T06)', () => {
  let prefix: string;

  beforeEach(() => {
    prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-react-alias-'));
  });
  afterEach(() => {
    fs.rmSync(prefix, { recursive: true, force: true });
  });

  it('emits both aliases when both directories exist', () => {
    const mods = path.join(prefix, 'lib', 'node_modules');
    fs.mkdirSync(path.join(mods, 'react'), { recursive: true });
    fs.mkdirSync(path.join(mods, 'react-dom'), { recursive: true });
    expect(reactAliasFlags(prefix)).toEqual([
      `--alias:react=${path.join(mods, 'react')}`,
      `--alias:react-dom=${path.join(mods, 'react-dom')}`,
    ]);
  });

  it('emits only what exists, and nothing for an empty prefix', () => {
    expect(reactAliasFlags(prefix)).toEqual([]);
    fs.mkdirSync(path.join(prefix, 'lib', 'node_modules', 'react'), { recursive: true });
    expect(reactAliasFlags(prefix)).toHaveLength(1);
  });
});
