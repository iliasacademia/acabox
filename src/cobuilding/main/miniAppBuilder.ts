/**
 * Shared mini-app esbuild entry point. Used by:
 *   - the renderer's "Rebuild" button (via the miniApps:build IPC)
 *   - the agent's mcp__mini-apps__build_and_open_mini_application tool
 *
 * Centralising this here means there's one place that knows how to resolve
 * the bundled esbuild binary and shape the command line.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { recordBuildResult } from './buildHealth';
import log from 'electron-log';
import { containerService } from './containerService';
import { getNpmPrefix } from './nodeSetup';

export interface MiniAppBuildResult {
  ok: boolean;
  outfile?: string;
  /** esbuild stderr (or stdout) when the build fails. */
  error?: string;
  exitCode: number;
}

/**
 * Locate the esbuild executable.
 *
 * In dev, `node_modules/.bin/esbuild` under the app path is correct. In a
 * PACKAGED build it is not: the forge webpack plugin ships only `.webpack/`
 * output plus the handful of native modules `packageAfterCopy` copies, so
 * `app.getAppPath()` (= `…/Resources/app.asar`) contains no esbuild at all.
 * The old unconditional path therefore pointed inside the archive and every
 * build in every packaged install died with a spawn ENOENT that surfaced as a
 * bare "esbuild exited with code 1" — as if the user's code hadn't compiled.
 *
 * Packaged builds get the real binary from `extraResource` (forge.config.js),
 * with the per-user npm-site as a secondary candidate for installs that
 * predate the shipped copy or run on a mismatched arch.
 */
function resolveEsbuildBin(): { bin: string } | { error: string } {
  const binName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, binName),
        path.join(getNpmPrefix(), 'bin', binName),
      ]
    : [path.resolve(app.getAppPath(), 'node_modules', '.bin', binName)];

  const bin = candidates.find((candidate) => fs.existsSync(candidate));
  if (bin) return { bin };
  return {
    error: `esbuild executable not found. Looked in:\n  ${candidates.join('\n  ')}`,
  };
}

export async function buildMiniApp(workspacePath: string, dirName: string): Promise<MiniAppBuildResult> {
  const appDir = path.join(workspacePath, '.applications', dirName);
  if (!fs.existsSync(appDir)) {
    return { ok: false, error: `Mini-application directory not found: .applications/${dirName}`, exitCode: 1 };
  }

  const entry = path.join(appDir, 'src', 'index.tsx');
  const outfile = path.join(appDir, 'dist', 'bundle.js');
  const reusableAlias = path.join(workspacePath, '.applications', '_reusable');

  const resolved = resolveEsbuildBin();
  if ('error' in resolved) {
    log.error(`[MiniAppBuilder] ${dirName}: ${resolved.error}`);
    return { ok: false, error: resolved.error, exitCode: 127 };
  }

  // execLogged (not exec) so the invocation lands in the command log / Debug
  // tab. Build failures used to leave no trace anywhere.
  const result = await containerService.execLogged([
    resolved.bin,
    entry,
    '--bundle',
    `--outfile=${outfile}`,
    '--jsx=automatic',
    '--loader:.tsx=tsx',
    '--loader:.ts=ts',
    '--format=iife',
    `--alias:@reusable=${reusableAlias}`,
  ], { source: 'build', appDirName: dirName });

  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
      || `esbuild exited with code ${result.exitCode} without output — the process may not have started.`;
    log.error(`[MiniAppBuilder] ${dirName}: build failed (exit ${result.exitCode}) via ${resolved.bin}: ${detail}`);
    // Recorded here rather than by the caller so every build path — the
    // Rebuild button and the agent's build tool — reports health identically.
    recordBuildResult(dirName, false, detail);
    return { ok: false, error: detail, exitCode: result.exitCode };
  }
  recordBuildResult(dirName, true);
  return { ok: true, outfile, exitCode: 0 };
}
