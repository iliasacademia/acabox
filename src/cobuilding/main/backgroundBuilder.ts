/**
 * Background Builder
 *
 * Watches .applications/ for new app folders or dep file changes and
 * installs their dependencies live into the running container.
 */

import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import { containerService } from './containerService';
import { getInstallSteps } from './environmentGenerator';
import { packageInstaller, installStepsToRequests } from './packageInstaller';

export class BackgroundBuilder {
  private watcher: fs.FSWatcher | null = null;

  // Track known app directories so we can detect new ones
  private knownApps = new Set<string>();

  /**
   * Watch .applications/ for new app folders or dep file changes.
   * Call after container start; call stopWatching() before switching workspace.
   *
   * @param onAppReady - called when an app's deps have been verified/installed,
   *   so the app can be marked as ready (skipping future ensureAppDeps checks).
   */
  startWatching(workspacePath: string, onAppReady?: (dirName: string) => void): void {
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

    // Ensure deps for all existing apps in the background. PackageInstaller
    // de-duplicates packages across apps, so each unique wheel installs once.
    if (containerService.isRunning()) {
      for (const appName of this.knownApps) {
        this.ensureAppLiveDeps(appsDir, appName).then(() => {
          onAppReady?.(appName);
        }).catch((err) => {
          log.warn(`[BackgroundBuilder] Live install for ${appName} failed: ${(err as Error).message}`);
        });
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
            this.ensureAppLiveDeps(appsDir, topDir).catch((err) => {
              log.warn(`[BackgroundBuilder] Live install for ${topDir} failed: ${(err as Error).message}`);
            });
          }
          return;
        }

        // Only trigger live install for dep-relevant file changes
        const basename = parts[parts.length - 1];
        const isDepFile = DEP_FILES.has(basename) || (parts.includes('setup') && basename.endsWith('.sh'));
        if (!isDepFile) return;

        log.debug(`[BackgroundBuilder] Dep file changed: ${filename}`);

        // Race protection: when a brand-new app is scaffolded, fs.watch usually
        // fires for the directory FIRST and only fires for the dep files inside
        // it ~100ms later, so the initial getInstallSteps returned []. Now that
        // the dep file has landed, re-request the deps (packageInstaller will
        // dedup against anything already installed).
        if (containerService.isRunning()) {
          this.ensureAppLiveDeps(appsDir, topDir).catch((err) => {
            log.warn(`[BackgroundBuilder] Late live install for ${topDir} failed: ${(err as Error).message}`);
          });
        }
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

  /** Stop watching. */
  dispose(): void {
    this.stopWatching();
  }

  ensureAppLiveDeps(appsDir: string, dirName: string): Promise<void> {
    const steps = getInstallSteps(appsDir, dirName);
    if (steps.length === 0) return Promise.resolve();
    return packageInstaller.ensureDeps(installStepsToRequests(steps, dirName));
  }
}
