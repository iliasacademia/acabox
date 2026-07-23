/**
 * Host-side npm setup.
 *
 * Mini-apps that declare npm dependencies install them into a shared prefix
 * under userData. esbuild bundles for those apps resolve the modules via
 * NODE_PATH = `${npmPrefix}/lib/node_modules`, the same way the original
 * container-based build used `/opt/npm-site`.
 *
 * We don't bundle npm itself — most users on macOS have it via Homebrew, nvm,
 * or the official installer. When it's missing we surface a clear, actionable
 * error rather than letting a low-level ENOENT bubble up.
 */

import { app } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { getLoginShellPath, prewarmLoginShellPath } from './shellPath';

const execFileAsync = promisify(execFile);

export function getNpmPrefix(): string {
  return path.join(app.getPath('userData'), 'npm-site');
}

/**
 * Path that should be added to NODE_PATH so node + esbuild can resolve
 * packages installed via the install wrapper.
 */
export function getNpmNodeModulesPath(): string {
  return path.join(getNpmPrefix(), 'lib', 'node_modules');
}

export class NpmUnavailableError extends Error {
  constructor() {
    super('npm is not installed on this system.');
    this.name = 'NpmUnavailableError';
  }
}

/**
 * Resolve to the absolute path of `npm` on this system, or throw a
 * NpmUnavailableError with installation guidance.
 */
export async function ensureNpmAvailable(): Promise<string> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  // Probe under the login-shell PATH — the same PATH the actual npm install
  // runs with (via buildSubprocessEnv) — so a Finder/Dock-launched build
  // doesn't reject npm that lives in Homebrew/nvm dirs launchd omits.
  await prewarmLoginShellPath();
  try {
    const { stdout } = await execFileAsync(probe, ['npm'], {
      timeout: 5000,
      env: { ...process.env, PATH: getLoginShellPath() },
    });
    const resolved = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (resolved) return resolved;
  } catch { /* fallthrough */ }
  throw new NpmUnavailableError();
}
