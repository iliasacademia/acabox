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
import { containerService } from './containerService';

export interface MiniAppBuildResult {
  ok: boolean;
  outfile?: string;
  /** esbuild stderr (or stdout) when the build fails. */
  error?: string;
  exitCode: number;
}

function getEsbuildBin(): string {
  const binName = process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild';
  return path.resolve(app.getAppPath(), 'node_modules', '.bin', binName);
}

export async function buildMiniApp(workspacePath: string, dirName: string): Promise<MiniAppBuildResult> {
  const appDir = path.join(workspacePath, '.applications', dirName);
  if (!fs.existsSync(appDir)) {
    return { ok: false, error: `Mini-application directory not found: .applications/${dirName}`, exitCode: 1 };
  }

  const entry = path.join(appDir, 'src', 'index.tsx');
  const outfile = path.join(appDir, 'dist', 'bundle.js');
  const reusableAlias = path.join(workspacePath, '.applications', '_reusable');

  const result = await containerService.exec([
    getEsbuildBin(),
    entry,
    '--bundle',
    `--outfile=${outfile}`,
    '--jsx=automatic',
    '--loader:.tsx=tsx',
    '--loader:.ts=ts',
    '--format=iife',
    `--alias:@reusable=${reusableAlias}`,
  ]);

  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `esbuild exited with code ${result.exitCode}`;
    return { ok: false, error: detail, exitCode: result.exitCode };
  }
  return { ok: true, outfile, exitCode: 0 };
}
