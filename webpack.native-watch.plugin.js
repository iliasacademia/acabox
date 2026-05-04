const chokidar = require('chokidar');
const { spawn } = require('child_process');
const path = require('path');

class NativeWatchPlugin {
  constructor(options = {}) {
    this.debounceDelay = options.debounceDelay || 300;
    this.nativePath = options.nativePath || path.join(__dirname, 'src/native');
    this.state = 'idle'; // idle, building, pending-rebuild
    this.debounceTimer = null;
    this.compiler = null;
  }

  apply(compiler) {
    this.compiler = compiler;

    // Only run in development mode
    if (compiler.options.mode !== 'development') {
      return;
    }

    if (process.platform !== 'darwin') {
      return;
    }

    compiler.hooks.afterEmit.tapAsync('NativeWatchPlugin', (compilation, callback) => {
      if (!this.watcher) {
        this.startWatching();
      }
      callback();
    });

    compiler.hooks.shutdown.tap('NativeWatchPlugin', () => {
      if (this.watcher) {
        this.watcher.close();
      }
    });
  }

  startWatching() {
    console.log('[NativeWatch] Starting native code file watcher...');

    this.watcher = chokidar.watch(
      ['**/*.mm', '**/*.cpp', '**/*.h', '**/*.gyp'],
      {
        cwd: this.nativePath,
        ignored: ['**/build/**', '**/node_modules/**'],
        persistent: true,
        ignoreInitial: true,
      }
    );

    this.watcher.on('change', (filePath) => {
      console.log(`[NativeWatch] Detected change in: ${filePath}`);
      this.handleFileChange(filePath);
    });

    this.watcher.on('error', (error) => {
      console.error('[NativeWatch] Watcher error:', error);
    });
  }

  handleFileChange(filePath) {
    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Debounce to batch rapid changes
    this.debounceTimer = setTimeout(() => {
      this.queueRebuild(filePath);
    }, this.debounceDelay);
  }

  queueRebuild(filePath) {
    if (this.state === 'idle') {
      // Start rebuild immediately
      this.state = 'building';
      this.rebuild(filePath);
    } else if (this.state === 'building') {
      // Mark that we need another rebuild after current one finishes
      console.log('[NativeWatch] Build in progress, queuing another rebuild...');
      this.state = 'pending-rebuild';
    }
    // If already pending-rebuild, do nothing (already queued)
  }

  rebuild(filePath) {
    console.log('[NativeWatch] Starting native module rebuild...');
    const startTime = Date.now();

    const rebuildProcess = spawn('npx', ['node-gyp', 'rebuild'], {
      cwd: this.nativePath,
      stdio: 'inherit',
      shell: true,
    });

    rebuildProcess.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      if (code === 0) {
        console.log(`[NativeWatch] Rebuild successful (${duration}s)`);

        // Check if more changes came in during build
        if (this.state === 'pending-rebuild') {
          console.log('[NativeWatch] Processing queued changes...');
          this.state = 'building';
          this.rebuild(filePath);
        } else {
          // No more changes, proceed with restart
          this.state = 'idle';
          this.restartMainProcess();
        }
      } else {
        console.error(`[NativeWatch] Rebuild failed with code ${code}`);
        this.state = 'idle';
      }
    });

    rebuildProcess.on('error', (error) => {
      console.error('[NativeWatch] Rebuild error:', error);
      this.state = 'idle';
    });
  }

  async restartMainProcess() {
    console.log('[NativeWatch] Requesting graceful cleanup before restart...');

    // Give the main process time to cleanup
    // The cleanup IPC handler will be called by Electron Forge's restart mechanism
    setTimeout(() => {
      console.log('[NativeWatch] Triggering main process restart...');

      // Invalidate the watching to trigger Electron Forge's restart
      if (this.compiler && this.compiler.watching) {
        // Touch a file to trigger webpack's watch mode restart
        const mainTsPath = path.join(__dirname, 'src/main.ts');
        const fs = require('fs');
        const now = new Date();
        fs.utimes(mainTsPath, now, now, (err) => {
          if (err) {
            console.error('[NativeWatch] Failed to touch main.ts:', err);
          }
        });
      }
    }, 100);
  }
}

module.exports = NativeWatchPlugin;
