/**
 * Background Builder
 *
 * Triggers debounced background image rebuilds when the environment changes.
 * Two detection paths:
 *   1. commandLogger — detects successful `.applications/install` commands
 *   2. fs.watch — detects new app folders or dep file changes (e.g., shared
 *      apps copied into the workspace while the app is running)
 *
 * State machine: idle → building → building-pending
 *   - idle: no build in progress. A trigger starts one.
 *   - building: build in progress. A trigger sets state to building-pending.
 *   - building-pending: build in progress AND another is needed. When the
 *     current build finishes, a new one starts automatically.
 */

import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import type { BrowserWindow } from 'electron';
import { containerService } from './containerService';
import type { CommandLogEntry } from './commandLogger';
import { installDepsInContainer } from './environmentGenerator';

const DEBOUNCE_MS = 5_000;

export type BuildState = 'idle' | 'building' | 'building-pending';

export class BackgroundBuilder {
  private state: BuildState = 'idle';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: fs.FSWatcher | null = null;

  constructor(
    private getWorkspacePath: () => string | null,
    private getMainWindow: () => BrowserWindow | null,
  ) {}

  // Track known app directories so we can detect new ones
  private knownApps = new Set<string>();

  /** Current build state for the debug panel. */
  getState(): BuildState {
    return this.state;
  }

  /** Call from commandLogger.onEntry listener. */
  onCommandEntry(entry: CommandLogEntry): void {
    if (this.isInstallCommand(entry)) {
      log.debug(`[BackgroundBuilder] Install detected: ${entry.command.join(' ')}`);
      this.scheduleRebuild();
    }
  }

  /**
   * Watch .applications/ for new app folders or dep file changes.
   * Call after container start; call stopWatching() before switching workspace.
   */
  startWatching(workspacePath: string): void {
    this.stopWatching();

    const appsDir = path.join(workspacePath, '.applications');
    if (!fs.existsSync(appsDir)) return;

    // Snapshot existing app directories so we can detect new ones
    this.knownApps.clear();
    for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('_')) {
        this.knownApps.add(entry.name);
      }
    }

    try {
      const DEP_FILES = new Set(['requirements.txt', 'package.json', 'r-packages.txt', 'apt-packages.txt']);

      this.watcher = fs.watch(appsDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const parts = filename.split(path.sep);
        const topDir = parts[0];
        if (topDir.startsWith('_') || filename === 'install') return;

        // Detect new app directories and install their deps live
        if (!this.knownApps.has(topDir)) {
          const dirPath = path.join(appsDir, topDir);
          if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
            this.knownApps.add(topDir);
            log.info(`[BackgroundBuilder] New app detected: ${topDir}, installing deps`);
            this.installAppDepsLive(appsDir, topDir);
          }
          this.scheduleRebuild();
          return;
        }

        // Only trigger rebuild for dep-relevant file changes
        const basename = parts[parts.length - 1];
        const isDepFile = DEP_FILES.has(basename) || (parts.includes('setup') && basename.endsWith('.sh'));
        if (!isDepFile) return;

        log.debug(`[BackgroundBuilder] Dep file changed: ${filename}`);
        this.scheduleRebuild();
      });

      this.watcher.on('error', (err) => {
        log.warn(`[BackgroundBuilder] Watcher error: ${err.message}`);
        this.stopWatching();
      });

      log.debug(`[BackgroundBuilder] Watching ${appsDir} for changes`);
    } catch (err) {
      log.warn(`[BackgroundBuilder] Failed to start watcher: ${(err as Error).message}`);
    }
  }

  /** Stop watching .applications/. */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Cancel timers and stop watching. */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.stopWatching();
  }

  // ─── Live Dep Install for New Apps ───────────────────────────

  private async installAppDepsLive(appsDir: string, dirName: string): Promise<void> {
    if (!containerService.isRunning()) return;
    try {
      const results = await installDepsInContainer(appsDir, dirName, (cmd) => containerService.exec(cmd));
      if (results.length > 0) log.info(`[BackgroundBuilder] Live deps installed for ${dirName}: ${results.join(', ')}`);
    } catch (err) {
      log.warn(`[BackgroundBuilder] Failed to install deps for ${dirName}: ${(err as Error).message}`);
    }
  }

  // ─── Detection ───────────────────────────────────────────────

  private isInstallCommand(entry: CommandLogEntry): boolean {
    if (entry.exitCode !== 0) return false;
    const joined = entry.command.join(' ');
    return joined.includes('.applications/install');
  }

  // ─── Debounce ────────────────────────────────────────────────

  private scheduleRebuild(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.triggerBuild();
    }, DEBOUNCE_MS);
  }

  // ─── State Machine ──────────────────────────────────────────

  private triggerBuild(): void {
    if (this.state === 'idle') {
      this.state = 'building';
      this.executeBuild().catch((err) => {
        log.error('[BackgroundBuilder] Build failed:', (err as Error).message);
      });
    } else if (this.state === 'building') {
      this.state = 'building-pending';
      log.debug('[BackgroundBuilder] Build in progress, will rebuild after it finishes');
    }
    // If already 'building-pending', nothing to do
  }

  private async executeBuild(): Promise<void> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      log.warn('[BackgroundBuilder] No workspace path, skipping build');
      this.state = 'idle';
      return;
    }

    if (!containerService.isRunning()) {
      log.debug('[BackgroundBuilder] Container not running, skipping background build');
      this.state = 'idle';
      return;
    }

    try {
      this.emitProgress('background-build', 'Updating container image...');
      log.info('[BackgroundBuilder] Starting background image rebuild');

      await containerService.rebuildImage(workspacePath, (stage, message, percent) => {
        this.emitProgress(stage, message, percent);
      });

      log.info('[BackgroundBuilder] Background build completed');
      this.emitProgress('background-build-done', 'Container image updated');
    } catch (err) {
      log.error('[BackgroundBuilder] Build error:', (err as Error).message);
      this.emitProgress('background-build-error', `Build failed: ${(err as Error).message}`);
    } finally {
      if (this.state === 'building-pending') {
        log.debug('[BackgroundBuilder] Pending rebuild detected, starting another build');
        this.state = 'building';
        this.executeBuild().catch((err) => {
          log.error('[BackgroundBuilder] Pending rebuild failed:', (err as Error).message);
        });
      } else {
        this.state = 'idle';
      }
    }
  }

  // ─── IPC ─────────────────────────────────────────────────────

  private emitProgress(stage: string, message: string, percent?: number): void {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('container:backgroundBuild', { stage, message, percent });
    }
  }
}
