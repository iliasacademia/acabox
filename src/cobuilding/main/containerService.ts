import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import log from 'electron-log';
import {
  getBundledPodmanBin,
  getBundledPodmanBinDir,
  getBundledPodmanEnv,
  ensureBinariesDownloaded,
} from './podmanBinaries';
import { commandLogger, parseAppDirFromArgs, type CommandSource } from './commandLogger';
import { generateEnvironment } from './environmentGenerator';

import * as net from 'net';
import * as http from 'http';

const execFileAsync = promisify(execFile);

/** Find a free TCP port in the given range by attempting to bind. */
function findFreePort(start: number, end: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryNext = () => {
      if (port > end) {
        reject(new Error(`No free port in range ${start}-${end}`));
        return;
      }
      const server = net.createServer();
      server.listen(port, '0.0.0.0', () => {
        server.close(() => resolve(port));
      });
      server.on('error', () => {
        port++;
        tryNext();
      });
    };
    tryNext();
  });
}

const GHCR_BASE_IMAGE = 'ghcr.io/academia-edu/cobuilding-base:latest';
const LOCAL_BASE_IMAGE = 'cobuilding-base:local';
const IMAGE_NAME = 'cobuilding-container';
const CONTAINER_NAME = 'cobuilding-container';

type BinaryMode = 'system' | 'bundled';
type ImageSource = 'registry' | 'local';
type ProgressCallback = (stage: string, message: string, percent?: number) => void;

/** Convert a Windows path (C:\Users\...) to a WSL mount path (/mnt/c/Users/...) for Podman volume mounts. */
function toMountPath(hostPath: string): string {
  if (process.platform !== 'win32') return hostPath;
  const match = hostPath.match(/^([A-Za-z]):[/\\](.*)/);
  if (!match) return hostPath;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function readBinaryMode(): BinaryMode {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.binaryMode === 'system' ? 'system' : 'bundled';
  } catch {
    return 'bundled';
  }
}

function writeBinaryMode(mode: BinaryMode): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // File doesn't exist yet
  }
  data.binaryMode = mode;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function readImageSource(): ImageSource {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.imageSource === 'local' ? 'local' : 'registry';
  } catch {
    return 'registry';
  }
}

function writeImageSource(source: ImageSource): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // File doesn't exist yet
  }
  data.imageSource = source;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

class CobuildingContainerService {
  private containerStarted = false;
  private isStarting = false;
  private currentWorkspacePath: string | null = null;
  private logTailInterval: ReturnType<typeof setInterval> | null = null;
  private lastLogTime: string = new Date().toISOString();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private agentPort: number | null = null;
  private overlayEnabled = false;

  // ─── Public API ─────────────────────────────────────────────────

  async start(workspacePath: string, onProgress?: ProgressCallback): Promise<void> {
    if (this.isRunning() && this.currentWorkspacePath === workspacePath) {
      return;
    }
    if (this.isStarting) {
      return;
    }

    // If running with a different workspace, stop the old container first
    if (this.isRunning() && this.currentWorkspacePath !== workspacePath) {
      log.debug(`[ContainerService] Workspace changed (${this.currentWorkspacePath} -> ${workspacePath}), restarting container...`);
      this.stop();
    }
    this.isStarting = true;

    try {
      // Ensure podman is available
      if (this.useBundled()) {
        await ensureBinariesDownloaded(onProgress);
      }
      const podmanBin = this.getPodmanBin();

      // Ensure podman machine is ready (macOS uses AppleHV, Windows uses WSL2)
      if (process.platform === 'darwin' || process.platform === 'win32') {
        await this.ensureMachineRunning(podmanBin, onProgress);
      }

      // Remove any stale container from a previous crash
      await this.removeStaleContainer(podmanBin);

      // Start the container from whatever image is available — either the full
      // image (with workspace deps baked in) or just the base image. The agent
      // becomes available immediately. If the full image isn't up to date, it
      // builds in the background for next restart.
      const hasFullImage = await this.imageExists(podmanBin, IMAGE_NAME);
      // Only check hash if the image exists with correct architecture
      const imageUpToDate = hasFullImage && await this.isImageUpToDate(podmanBin, workspacePath);
      log.info(`[ContainerService] Image state: upToDate=${imageUpToDate}, hasFullImage=${hasFullImage}`);

      if (imageUpToDate) {
        // Full image is current — start directly
        await this.runContainer(podmanBin, workspacePath);
      } else if (hasFullImage) {
        // Full image exists but is stale — start from it now, rebuild in background
        log.info('[ContainerService] Starting from existing image, rebuilding in background');
        await this.runContainer(podmanBin, workspacePath);
        this.ensureImageBuilt(podmanBin, undefined, workspacePath).catch((err) => {
          log.warn(`[ContainerService] Background image build failed: ${(err as Error).message}`);
        });
      } else {
        // No full image — start from the base image immediately so the agent
        // is available. Build the full image (with workspace deps) in the
        // background for next restart. App deps install live via backgroundBuilder.
        const imageSource = readImageSource();
        const baseImage = imageSource === 'registry' ? GHCR_BASE_IMAGE : LOCAL_BASE_IMAGE;
        log.info(`[ContainerService] Starting from base image (${baseImage}), building full image in background`);
        await this.runContainer(podmanBin, workspacePath, baseImage);
        this.ensureImageBuilt(podmanBin, undefined, workspacePath).catch((err) => {
          log.warn(`[ContainerService] Background image build failed: ${(err as Error).message}`);
        });
      }

      log.debug('[ContainerService] Container started successfully');
      onProgress?.('ready', 'Container ready');
    } catch (error) {
      log.error('[ContainerService] Error:', (error as Error).message);
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  stop(): void {
    this.stopLogTail();
    this.stopHealthWatch();
    log.debug('[ContainerService] Stopping container...');
    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();

    if (this.overlayEnabled) {
      try {
        log.info('[ContainerService] Syncing overlay before stop...');
        execFileSync(podmanBin, [
          'exec', CONTAINER_NAME,
          'rsync', '-a', '--delete',
          '--exclude', '.academia/claude',
          '--exclude', '.academia/agent-server.js',
          '--exclude', '.academia/agent.json',
          '--exclude', 'node_modules/.cache',
          '/data/', '/data-host/',
        ], { env, timeout: 60_000 });
        log.info('[ContainerService] Overlay sync complete');
      } catch (err) {
        log.warn(`[ContainerService] Overlay sync failed: ${(err as Error).message}`);
      }
    }

    try {
      execFileSync(podmanBin, ['stop', '-t', '3', CONTAINER_NAME], { env, timeout: 10000 });
      log.debug('[ContainerService] Container stopped');
    } catch {
      log.debug('[ContainerService] Container was not running or already stopped');
    }

    try {
      execFileSync(podmanBin, ['rm', '-f', CONTAINER_NAME], { env, timeout: 5000 });
      log.debug('[ContainerService] Container removed');
    } catch {
      // Already removed
    }

    this.containerStarted = false;
    this.currentWorkspacePath = null;
    this.overlayEnabled = false;
  }

  isRunning(): boolean {
    if (!this.containerStarted) return false;

    try {
      const podmanBin = this.getPodmanBin();
      const result = execFileSync(podmanBin, [
        'inspect', '--format', '{{.State.Running}}', CONTAINER_NAME,
      ], { env: this.getExecEnv(), timeout: 5000, encoding: 'utf-8' });
      return result.trim() === 'true';
    } catch {
      return false;
    }
  }

  async exec(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.isRunning()) {
      throw new Error('Container is not running');
    }
    const podmanBin = this.getPodmanBin();
    const args = ['exec', CONTAINER_NAME, ...command];
    const env = this.getExecEnv();
    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(podmanBin, args, { env, timeout: 600_000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode };
    }
  }

  /** Like exec() but streams stdout/stderr lines to a callback as they arrive. */
  execStreaming(
    command: string[],
    onLine: (line: string) => void,
  ): Promise<{ exitCode: number }> {
    if (!this.isRunning()) {
      throw new Error('Container is not running');
    }
    const podmanBin = this.getPodmanBin();
    const args = ['exec', CONTAINER_NAME, ...command];
    return new Promise((resolve, reject) => {
      const proc = spawn(podmanBin, args, {
        env: this.getExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const handleData = (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      };

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);

      proc.on('close', (code) => {
        resolve({ exitCode: code ?? 0 });
      });

      proc.on('error', (error) => {
        reject(new Error(`exec failed: ${error.message}`));
      });
    });
  }

  async execLogged(
    command: string[],
    meta?: { source?: CommandSource; appDirName?: string | null },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.exec(command);
    commandLogger.log({
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      appDirName: meta?.appDirName ?? parseAppDirFromArgs(command),
      source: meta?.source ?? 'agent',
    });
    return result;
  }

  // ─── Binary Mode ──────────────────────────────────────────────

  getBinaryMode(): BinaryMode {
    return readBinaryMode();
  }

  setBinaryMode(mode: BinaryMode): void {
    if (this.isRunning()) {
      throw new Error('Cannot change binary mode while container is running');
    }
    writeBinaryMode(mode);
    log.debug(`[ContainerService] Binary mode set to: ${mode}`);
  }

  // ─── Image Source ──────────────────────────────────────────────

  getImageSource(): ImageSource {
    return readImageSource();
  }

  setImageSource(source: ImageSource): void {
    if (this.isRunning()) {
      throw new Error('Cannot change image source while container is running');
    }
    writeImageSource(source);
    log.debug(`[ContainerService] Image source set to: ${source}`);
  }

  getBundledBinaryStatus(): { downloaded: boolean; binDir: string } {
    const binDir = getBundledPodmanBinDir();
    const binaries = process.platform === 'win32'
      ? ['podman.exe', 'gvproxy-windows.exe', 'win-sshproxy.exe']
      : ['podman', 'gvproxy', 'vfkit'];
    return {
      downloaded: binaries.every(name => fs.existsSync(path.join(binDir, name))),
      binDir,
    };
  }

  async downloadBundledBinaries(onProgress?: ProgressCallback): Promise<void> {
    await ensureBinariesDownloaded(onProgress);
  }

  deleteBundledBinaries(): void {
    if (this.isRunning() && this.useBundled()) {
      throw new Error('Cannot delete binaries while container is running with bundled mode');
    }
    const binDir = getBundledPodmanBinDir();
    if (fs.existsSync(binDir)) {
      fs.rmSync(binDir, { recursive: true, force: true });
      log.debug('[ContainerService] Bundled binaries deleted');
    }
  }

  /** Return the environment hash label stored on the current image, or null. */
  async getImageEnvironmentHash(): Promise<string | null> {
    const podmanBin = this.getPodmanBin();
    return this.getImageHash(podmanBin);
  }

  /**
   * Rebuild the container image from current workspace dependencies.
   * Intended for background rebuilds — does NOT restart the container.
   */
  async rebuildImage(workspacePath: string, onProgress?: ProgressCallback): Promise<void> {
    if (this.isStarting) {
      log.debug('[ContainerService] Foreground start in progress, skipping background rebuild');
      return;
    }
    const podmanBin = this.getPodmanBin();
    await this.ensureImageBuilt(podmanBin, onProgress, workspacePath);
  }

  async deleteImage(): Promise<void> {
    if (this.isRunning()) {
      throw new Error('Cannot delete image while container is running');
    }
    try {
      const podmanBin = this.getPodmanBin();
      // Remove the skills layer image
      await this.execAsync(podmanBin, ['rmi', '-f', IMAGE_NAME], this.getExecEnv());
      log.debug('[ContainerService] Skills layer image deleted');
    } catch (error) {
      log.error('[ContainerService] Failed to delete skills image:', (error as Error).message);
    }
    try {
      const podmanBin = this.getPodmanBin();
      // Also remove the cached base image so the next setup pulls fresh from registry
      await this.execAsync(podmanBin, ['rmi', '-f', GHCR_BASE_IMAGE], this.getExecEnv());
      log.debug('[ContainerService] Base image deleted');
    } catch (error) {
      log.debug('[ContainerService] No base image to remove (or already removed)');
    }
    try {
      const podmanBin = this.getPodmanBin();
      await this.execAsync(podmanBin, ['rmi', '-f', LOCAL_BASE_IMAGE], this.getExecEnv());
      log.debug('[ContainerService] Local base image deleted');
    } catch (error) {
      log.debug('[ContainerService] No local base image to remove (or already removed)');
    }
  }

  getContainerName(): string {
    return CONTAINER_NAME;
  }

  getPodmanEnv(): NodeJS.ProcessEnv {
    return this.getExecEnv();
  }

  getAgentPort(): number | null {
    return this.agentPort;
  }

  /**
   * Copy the agent server bundle and Linux claude binary to the workspace mount.
   * The binary is only re-copied when its size changes (new SDK version).
   */
  async ensureAgentFilesInWorkspace(workspacePath: string): Promise<void> {
    const agentDir = path.join(workspacePath, '.academia');
    fs.mkdirSync(agentDir, { recursive: true });

    // Copy agent server bundle (small, always copy to pick up code changes)
    const bundleSrc = app.isPackaged
      ? path.join(process.resourcesPath, 'agent-server.js')
      : path.join(app.getAppPath(), 'dist', 'agent-server.js');
    if (fs.existsSync(bundleSrc)) {
      if (this.overlayEnabled) {
        await this.podmanCp(bundleSrc, '/data/.academia/agent-server.js');
      } else {
        fs.copyFileSync(bundleSrc, path.join(agentDir, 'agent-server.js'));
      }
      log.debug('[ContainerService] Copied agent-server.js to workspace');
    } else {
      log.warn(`[ContainerService] Agent server bundle not found at ${bundleSrc}`);
    }

    // Copy Linux claude binary — skip if already present and same size (version match)
    const { resolveLinuxClaudeBinary } = await import('./sdkBinarySetup');
    const binarySrc = resolveLinuxClaudeBinary();
    log.debug(`[ContainerService] Linux binary resolved: ${binarySrc ?? 'NOT FOUND'}`);
    if (binarySrc) {
      const binaryDest = path.join(agentDir, 'claude');
      const srcStat = fs.statSync(binarySrc);
      let needsCopy = true;

      if (!this.overlayEnabled) {
        let destStat: fs.Stats | null = null;
        try { destStat = fs.statSync(binaryDest); } catch { /* does not exist */ }
        needsCopy = !destStat || destStat.size !== srcStat.size;
      }

      if (needsCopy) {
        if (this.overlayEnabled) {
          await this.podmanCp(binarySrc, '/data/.academia/claude');
          await this.exec(['chmod', '+x', '/data/.academia/claude']);
        } else {
          fs.copyFileSync(binarySrc, binaryDest);
          fs.chmodSync(binaryDest, 0o755);
        }
        log.info(`[ContainerService] Copied claude binary (${Math.round(srcStat.size / 1e6)}MB)`);
      } else {
        log.debug('[ContainerService] Claude binary already up to date, skipping copy');
      }
    } else {
      log.warn('[ContainerService] Linux claude binary not found in node_modules');
    }
  }

  /**
   * Start the agent server process inside the container.
   * Waits for the health endpoint to respond before returning.
   *
   * Idempotent: if an agent server is already running on the configured
   * port and responding to /health, this short-circuits without touching
   * it. Restarts kill in-flight model sessions, and renderer remounts
   * (e.g. closing the main window + reopening, which resets the
   * SetupBanner module guard and re-fires ensureSetup) should not be
   * able to drop an active conversation underneath the user.
   */
  async startAgentServer(configJson: string, workspacePath: string): Promise<void> {
    if (await this.isAgentServerHealthy()) {
      log.debug('[ContainerService] Agent server already healthy — skipping restart');
      return;
    }

    // Kill any existing (unhealthy / orphaned) agent server first
    await this.stopAgentServer();

    // Write config to workspace
    if (this.overlayEnabled) {
      await this.writeContentToContainer(configJson, '/data/.academia/agent.json');
    } else {
      const configPath = path.join(workspacePath, '.academia', 'agent.json');
      fs.writeFileSync(configPath, configJson, 'utf-8');
    }

    // Start the server inside the container (non-detached so we can capture output)
    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();
    const proc = spawn(podmanBin, [
      'exec',
      '-e', 'COBUILDING_INSIDE_CONTAINER=1',
      CONTAINER_NAME,
      'node', '/data/.academia/agent-server.js',
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    // Log stdout/stderr from the agent server
    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.info(`[AgentServer] ${line}`);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.error(`[AgentServer] ${line}`);
      }
    });
    proc.on('exit', (code, signal) => {
      log.warn(`[AgentServer] Process exited (code=${code}, signal=${signal})`);
    });

    // Wait for the health endpoint to respond (up to 10 seconds)
    const agentPort = this.agentPort;
    if (!agentPort) {
      log.error('[ContainerService] No agent port assigned');
      return;
    }

    const startTime = Date.now();
    const timeoutMs = 10_000;
    while (Date.now() - startTime < timeoutMs) {
      if (await this.isAgentServerHealthy(2000)) {
        log.info('[ContainerService] Agent server healthy');
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    log.error('[ContainerService] Agent server failed to become healthy within 10s');
  }

  /**
   * One-shot /health probe. Returns true iff the agent server on the
   * currently-assigned port responds 200 within the timeout. Used both
   * as a pre-check in startAgentServer (skip restart if already healthy)
   * and as the unit-step of the post-spawn readiness poll.
   */
  private async isAgentServerHealthy(timeoutMs = 1500): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/health',
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  /**
   * Stop the agent server process inside the container.
   *
   * Logs a stack trace on every invocation so that if a running session is
   * unexpectedly killed mid-task ([AgentServer] Process exited code=0
   * signal=null), we can see exactly which caller fired pkill — most likely
   * a re-entrant startAgentServer() (re-init) or a stray container:stop.
   */
  async stopAgentServer(): Promise<void> {
    const trace = new Error('stopAgentServer call site').stack;
    log.warn(`[ContainerService] stopAgentServer invoked\n${trace}`);
    try {
      await this.exec(['pkill', '-f', 'agent-server.js']);
    } catch {
      // Process may not be running
    }
    log.debug('[ContainerService] Agent server stopped');
  }

  writeStartContainerScript(workspaceDir: string): void {
    const academiaDir = path.join(workspaceDir, '.academia');
    fs.mkdirSync(academiaDir, { recursive: true });
    const scriptPath = path.join(academiaDir, 'start-container');

    // Compute the podman binary path without requiring it to exist yet
    // (binaries may not be downloaded until the user starts the container).
    const podmanBin = this.useBundled()
      ? path.join(getBundledPodmanBinDir(), process.platform === 'win32' ? 'podman.exe' : 'podman')
      : 'podman';

    const mountPath = toMountPath(path.resolve(workspaceDir));

    let envExports = '';
    if (this.useBundled()) {
      // getBundledPodmanEnv() computes stable paths; safe to call before binaries exist.
      const env = getBundledPodmanEnv();
      const keys = [
        'PATH',
        'CONTAINERS_MACHINE_PROVIDER',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_RUNTIME_DIR',
        'HOME',
      ] as const;
      envExports = keys
        .filter((k) => env[k] != null)
        .map((k) => `export ${k}="${env[k]}"`)
        .join('\n') + '\n\n';
    }

    const script = [
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      `PODMAN_BIN="${podmanBin}"`,
      `WORKSPACE_PATH="${mountPath}"`,
      `CONTAINER_NAME="${CONTAINER_NAME}"`,
      `IMAGE_NAME="${IMAGE_NAME}"`,
      '',
      envExports +
        '# If the container is already running, there is nothing to do.',
      'if "$PODMAN_BIN" inspect --format \'{{.State.Running}}\' "$CONTAINER_NAME" 2>/dev/null | grep -q \'^true$\'; then',
      '  echo "Container is already running."',
      '  exit 0',
      'fi',
      '',
      'echo "Starting $CONTAINER_NAME..."',
      ...(process.platform === 'darwin' ? [
        '"$PODMAN_BIN" run -d \\',
        '  --replace \\',
        '  --privileged \\',
        '  --name "$CONTAINER_NAME" \\',
        '  -v "$WORKSPACE_PATH:/data-host" \\',
        '  "$IMAGE_NAME" \\',
        '  sh -c "mount -t tmpfs tmpfs /tmp -o size=4G && mkdir -p /tmp/overlay-upper /tmp/overlay-work && mount -t overlay overlay -o lowerdir=/data-host,upperdir=/tmp/overlay-upper,workdir=/tmp/overlay-work /data && sleep infinity"',
      ] : [
        '"$PODMAN_BIN" run -d \\',
        '  --replace \\',
        '  --name "$CONTAINER_NAME" \\',
        '  -v "$WORKSPACE_PATH:/data" \\',
        '  "$IMAGE_NAME" \\',
        '  sleep infinity',
      ]),
      '',
      '# Wait up to 30 seconds for the container to become running.',
      'for i in $(seq 1 30); do',
      '  if "$PODMAN_BIN" inspect --format \'{{.State.Running}}\' "$CONTAINER_NAME" 2>/dev/null | grep -q \'^true$\'; then',
      '    echo "Container started."',
      '    exit 0',
      '  fi',
      '  sleep 1',
      'done',
      '',
      'echo "Container did not start within 30 seconds." >&2',
      'exit 1',
      '',
    ].join('\n');

    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  }

  async ensureSetup(onProgress?: ProgressCallback, workspacePath?: string): Promise<void> {
    const mode = readBinaryMode();

    // Step 1: If bundled mode, ensure binaries are downloaded
    if (mode === 'bundled') {
      const { downloaded } = this.getBundledBinaryStatus();
      if (!downloaded) {
        onProgress?.('install-podman', 'Downloading Podman binaries...');
        await ensureBinariesDownloaded(onProgress);
        onProgress?.('install-podman-done', 'Podman installed');
      }
    }

    // Step 2: Ensure podman machine is ready (macOS uses AppleHV, Windows uses WSL2)
    try {
      const podmanBin = this.getPodmanBin();
      if (process.platform === 'darwin' || process.platform === 'win32') {
        await this.ensureMachineRunning(podmanBin, onProgress);
      }

      // Step 3: Ensure the base image is available (pull or local build).
      // The full image build (with workspace deps) is deferred to start() —
      // the container can run from the base image immediately and deps install
      // live when apps are opened, so the agent is available without waiting.
      await this.ensureBaseImage(podmanBin, onProgress);
    } catch (error) {
      log.error('[ContainerService] ensureSetup error:', (error as Error).message);
      throw error;
    }

    onProgress?.('setup-done', 'Setup complete');
  }

  async isImageBuilt(): Promise<boolean> {
    try {
      const podmanBin = this.getPodmanBin();
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{.Id}}', IMAGE_NAME,
      ], this.getExecEnv());
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private useBundled(): boolean {
    return readBinaryMode() === 'bundled';
  }

  // ─── Podman Binary Resolution ──────────────────────────────────

  private getPodmanBin(): string {
    if (this.useBundled()) {
      return getBundledPodmanBin();
    }
    return 'podman';
  }

  private getExecEnv(): NodeJS.ProcessEnv {
    if (this.useBundled()) {
      return getBundledPodmanEnv();
    }
    return process.env;
  }

  // ─── Machine Lifecycle ──────────────────────────────────────────

  private async ensureMachineRunning(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const env = this.getExecEnv();

    // Pre-flight check: verify the podman binary can execute (catches Gatekeeper/quarantine issues)
    try {
      await this.execAsync(podmanBin, ['--version'], env);
    } catch (err: any) {
      const code = err?.code;
      const signal = err?.signal;
      if (code === 'EACCES' || code === 'EPERM' || signal === 'SIGKILL') {
        throw new Error(
          'macOS blocked Podman from running. This usually means the binary was quarantined by Gatekeeper. ' +
          'Try deleting the Podman binaries in Settings and re-downloading them, or check System Settings > Privacy & Security.'
        );
      }
      throw new Error(`Podman binary check failed: ${err?.message || err}`);
    }

    const initialized = await this.isMachineInitialized(podmanBin, env);
    if (!initialized) {
      onProgress?.('init', 'Initializing Podman VM (first-time setup)...');
      log.debug('[ContainerService] Machine not initialized, running podman machine init...');
      await this.spawnAndWait(podmanBin, ['machine', 'init', '--user-mode-networking'], env, 'machine init');
    }

    const running = await this.isMachineRunning(podmanBin, env);
    if (!running) {
      onProgress?.('start-machine', 'Starting Podman VM...');
      log.debug('[ContainerService] Machine not running, starting...');
      await this.spawnAndWait(podmanBin, ['machine', 'start'], env, 'machine start');
    }

    // Verify the API socket is actually responsive. podman machine list
    // reads the machine config (which has the correct port) but the CLI
    // connects via the connection config (podman-connections.json) which
    // can have a stale SSH port after restarts or upgrades.
    const socketReady = await this.waitForSocket(podmanBin, env, running ? 3 : 10, 2000);

    if (!socketReady) {
      log.warn('[ContainerService] Podman socket unresponsive, restarting machine to refresh connection config...');
      onProgress?.('start-machine', 'Podman VM unresponsive, restarting...');

      try {
        await this.spawnAndWait(podmanBin, ['machine', 'stop'], env, 'machine stop');
      } catch (stopErr) {
        log.warn('[ContainerService] Machine stop during recovery failed:', (stopErr as Error).message);
      }

      onProgress?.('start-machine', 'Restarting Podman VM...');
      await this.spawnAndWait(podmanBin, ['machine', 'start'], env, 'machine start');

      const readyAfterRestart = await this.waitForSocket(podmanBin, env, 10, 2000);
      if (!readyAfterRestart) {
        throw new Error(
          'Podman VM started but API socket is not responding. ' +
          'Try resetting the Podman VM in Settings or restarting the application.'
        );
      }
      log.info('[ContainerService] Machine recovered — connection config refreshed by machine start');
    }
  }

  private async isMachineInitialized(podmanBin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      const { stdout } = await this.execAsync(podmanBin, ['machine', 'list', '--format', 'json'], env);
      const machines = JSON.parse(stdout);
      return Array.isArray(machines) && machines.length > 0;
    } catch {
      return false;
    }
  }

  private async isMachineRunning(podmanBin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      const { stdout } = await this.execAsync(podmanBin, ['machine', 'list', '--format', 'json'], env);
      const machines = JSON.parse(stdout);
      if (!Array.isArray(machines) || machines.length === 0) return false;
      return machines.some((m: { Running?: boolean }) => m.Running === true);
    } catch {
      return false;
    }
  }

  private async isSocketResponsive(podmanBin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      await this.execAsync(podmanBin, ['info', '--format', '{{.Host.RemoteSocket.Exists}}'], env);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForSocket(podmanBin: string, env: NodeJS.ProcessEnv, maxAttempts: number, delayMs: number): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (await this.isSocketResponsive(podmanBin, env)) return true;
      if (attempt < maxAttempts) {
        log.debug(`[ContainerService] Socket not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  // ─── Image Management ─────────────────────────────────────────

  private getDockerfileDir(): string {
    if (app.isPackaged) {
      return process.resourcesPath;
    }
    return path.join(app.getAppPath(), 'src', 'cobuilding');
  }

  private getDockerfileHash(): string {
    const contextDir = this.getDockerfileDir();
    const hash = crypto.createHash('sha256');

    const dockerfilePath = path.join(contextDir, 'Dockerfile');
    hash.update(fs.readFileSync(dockerfilePath));

    return hash.digest('hex').substring(0, 16);
  }

  private async getImageHash(podmanBin: string): Promise<string | null> {
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{index .Config.Labels "dockerfile.hash"}}', IMAGE_NAME,
      ], this.getExecEnv());
      const hash = stdout.trim();
      return hash && hash !== '<no value>' ? hash : null;
    } catch {
      return null;
    }
  }

  private async ensureBaseImagePulled(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const localDigest = await this.getLocalDigest(podmanBin);

    if (localDigest) {
      // Image exists locally — check if it's up to date
      const remoteDigest = await this.getRemoteDigest(podmanBin);
      if (!remoteDigest) {
        log.warn('[ContainerService] Could not fetch remote digest (offline?), using local base image');
        return;
      }
      if (localDigest === remoteDigest) {
        log.debug('[ContainerService] Base image up to date');
        return;
      }
      log.debug(`[ContainerService] Base image stale (local: ${localDigest.substring(0, 16)}, remote: ${remoteDigest.substring(0, 16)}), pulling update...`);
      onProgress?.('pull', 'Base image outdated, pulling update...', 0);
    } else {
      log.debug(`[ContainerService] Pulling base image: ${GHCR_BASE_IMAGE}`);
      onProgress?.('pull', 'Pulling base image from registry...', 0);
    }

    const totalLayers = await this.getRemoteLayerCount(podmanBin);
    await this.spawnPullWithProgress(podmanBin, GHCR_BASE_IMAGE, totalLayers, onProgress);
    log.debug('[ContainerService] Base image pulled successfully');
  }

  async updateBaseImage(onProgress?: ProgressCallback): Promise<void> {
    const podmanBin = this.getPodmanBin();
    log.debug(`[ContainerService] Force-pulling latest base image: ${GHCR_BASE_IMAGE}`);
    onProgress?.('pull', 'Pulling latest base image from registry...', 0);

    const totalLayers = await this.getRemoteLayerCount(podmanBin);
    await this.spawnPullWithProgress(podmanBin, GHCR_BASE_IMAGE, totalLayers, onProgress);
    log.debug('[ContainerService] Base image updated');
  }

  private async getLocalDigest(podmanBin: string): Promise<string | null> {
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{.Digest}}', GHCR_BASE_IMAGE,
      ], this.getExecEnv());
      const digest = stdout.trim();
      return digest && digest !== '<no value>' ? digest : null;
    } catch {
      return null;
    }
  }

  private async getRemoteDigest(podmanBin: string): Promise<string | null> {
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'manifest', 'inspect', GHCR_BASE_IMAGE,
      ], this.getExecEnv());
      const parsed = JSON.parse(stdout);

      // Direct image manifest — return its digest
      if (parsed.config?.digest) {
        return parsed.config.digest;
      }

      // Manifest list — return the entry matching the host architecture
      if (parsed.manifests) {
        const targetArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
        const match = parsed.manifests.find(
          (m: { platform?: { architecture?: string; os?: string } }) =>
            m.platform?.architecture === targetArch && m.platform?.os === 'linux'
        );
        if (match?.digest) {
          return match.digest;
        }
      }
    } catch (error) {
      log.debug(`[ContainerService] Could not determine remote digest: ${(error as Error).message}`);
    }
    return null;
  }

  private async getRemoteLayerCount(podmanBin: string): Promise<number> {
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'manifest', 'inspect', GHCR_BASE_IMAGE,
      ], this.getExecEnv());
      const parsed = JSON.parse(stdout);

      // Direct image manifest — has layers array
      if (parsed.layers) {
        log.debug(`[ContainerService] Manifest has ${parsed.layers.length} layers`);
        return parsed.layers.length;
      }

      // Manifest list — find the entry matching host architecture and fetch its manifest
      if (parsed.manifests) {
        const targetArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
        const archMatch = parsed.manifests.find(
          (m: { platform?: { architecture?: string; os?: string } }) =>
            m.platform?.architecture === targetArch && m.platform?.os === 'linux'
        );
        if (archMatch?.digest) {
          const imageRef = GHCR_BASE_IMAGE.replace(/:([^@]+)$/, `@${archMatch.digest}`);
          const { stdout: imageManifest } = await this.execAsync(podmanBin, [
            'manifest', 'inspect', imageRef,
          ], this.getExecEnv());
          const imageParsed = JSON.parse(imageManifest);
          if (imageParsed.layers) {
            log.debug(`[ContainerService] Image manifest has ${imageParsed.layers.length} layers`);
            return imageParsed.layers.length;
          }
        }
      }
    } catch (error) {
      log.debug(`[ContainerService] Could not determine layer count: ${(error as Error).message}`);
    }
    return -1;
  }

  private spawnPullWithProgress(
    podmanBin: string,
    image: string,
    totalLayers: number,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
      const proc = spawn(podmanBin, ['pull', '--platform', platform, image], {
        env: this.getExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let completedSteps = 0;
      // +1 for the config descriptor
      const totalSteps = totalLayers > 0 ? totalLayers + 1 : -1;
      let stderrBuffer = '';

      proc.stderr?.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
        const lines = stderrBuffer.split(/\r?\n/);
        // Keep the last (possibly incomplete) line in the buffer
        stderrBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          log.debug(`[ContainerService] [pull] ${trimmed}`);

          if (/Copying (blob|config).*done/i.test(trimmed)) {
            completedSteps++;
            if (totalSteps > 0) {
              const percent = Math.min(Math.round((completedSteps / totalSteps) * 100), 99);
              onProgress?.('pull', `Downloading: layer ${completedSteps} of ${totalSteps}`, percent);
            } else {
              onProgress?.('pull', `Downloading: ${completedSteps} layers completed`);
            }
          } else if (/Writing manifest/i.test(trimmed)) {
            onProgress?.('pull', 'Writing manifest...', totalSteps > 0 ? 99 : undefined);
          }
        }
      });

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) log.debug(`[ContainerService] [pull stdout] ${line}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          onProgress?.('pull', 'Base image downloaded', 100);
          resolve();
        } else {
          const lastStderr = stderrBuffer.trim();
          reject(new Error(`podman pull exited with code ${code}${lastStderr ? ': ' + lastStderr : ''}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to pull base image: ${error.message}`));
      });
    });
  }

  /** Check if the container image is up to date without building. */
  private async isImageUpToDate(podmanBin: string, workspacePath?: string): Promise<boolean> {
    const imageSource = readImageSource();
    const baseImage = imageSource === 'registry' ? GHCR_BASE_IMAGE : LOCAL_BASE_IMAGE;
    let currentHash: string;
    if (workspacePath) {
      const result = generateEnvironment(workspacePath, baseImage);
      currentHash = result.hash;
    } else {
      currentHash = this.getDockerfileHash();
    }
    const imageHash = await this.getImageHash(podmanBin);
    return imageHash === currentHash;
  }

  /** Check if a named image exists in the local store with the correct architecture. */
  private async imageExists(podmanBin: string, imageName: string): Promise<boolean> {
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{.Id}} {{.Architecture}}', imageName,
      ], this.getExecEnv());
      const parts = stdout.trim().split(' ');
      if (parts.length < 2 || !parts[0]) return false;
      const imageArch = parts[1];
      const hostArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      if (imageArch !== hostArch) {
        log.warn(`[ContainerService] Image ${imageName} has wrong architecture (${imageArch}, need ${hostArch})`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure the base image is available (pull from registry or build locally). */
  private async ensureBaseImage(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const imageSource = readImageSource();
    if (imageSource === 'registry') {
      await this.ensureBaseImagePulled(podmanBin, onProgress);
    } else {
      await this.buildBaseImageLocally(podmanBin, onProgress);
    }
  }

  private async ensureImageBuilt(podmanBin: string, onProgress?: ProgressCallback, workspacePath?: string): Promise<void> {
    const imageSource = readImageSource();
    const baseImage = imageSource === 'registry' ? GHCR_BASE_IMAGE : LOCAL_BASE_IMAGE;

    let currentHash: string;
    let buildContext: string;
    let dockerfilePath: string;

    if (workspacePath) {
      // Generate environment from workspace dependency files
      const result = generateEnvironment(workspacePath, baseImage);
      currentHash = result.hash;
      buildContext = result.environmentDir;
      dockerfilePath = result.dockerfilePath;
    } else {
      // Fallback: no workspace available, use static Dockerfile
      const contextDir = this.getDockerfileDir();
      dockerfilePath = path.join(contextDir, 'Dockerfile');
      currentHash = this.getDockerfileHash();
      buildContext = contextDir;
    }

    const imageHash = await this.getImageHash(podmanBin);

    if (imageHash === currentHash) {
      log.debug(`[ContainerService] Image up to date (hash: ${currentHash})`);
      return;
    }

    if (imageSource === 'registry') {
      await this.ensureBaseImagePulled(podmanBin, onProgress);
    } else {
      await this.buildBaseImageLocally(podmanBin, onProgress);
    }

    if (imageHash) {
      log.debug(`[ContainerService] Environment changed (${imageHash} -> ${currentHash}), rebuilding...`);
      onProgress?.('build', 'Environment changed, rebuilding image...');
    } else {
      log.debug('[ContainerService] Building container image...');
      onProgress?.('build', 'Building container image...');
    }

    return this.spawnBuild(podmanBin, [
      'build',
      '--label', `dockerfile.hash=${currentHash}`,
      '--build-arg', `BASE_IMAGE=${baseImage}`,
      '-t', IMAGE_NAME,
      '-f', dockerfilePath,
      buildContext,
    ], onProgress);
  }

  private async buildBaseImageLocally(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    // Check if local base image already exists
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{.Id}}', LOCAL_BASE_IMAGE,
      ], this.getExecEnv());
      if (stdout.trim().length > 0) {
        log.debug('[ContainerService] Local base image already built');
        return;
      }
    } catch {
      // Image not present — build it
    }

    log.debug('[ContainerService] Building base image locally (this will take a while)...');
    onProgress?.('build', 'Building base image locally (this may take 20+ minutes)...');

    const contextDir = this.getDockerfileDir();
    const dockerfileBasePath = path.join(contextDir, 'Dockerfile.base');

    await this.spawnBuild(podmanBin, [
      'build',
      '-t', LOCAL_BASE_IMAGE,
      '-f', dockerfileBasePath,
      contextDir,
    ], onProgress);

    log.debug('[ContainerService] Local base image built successfully');
  }

  private spawnBuild(podmanBin: string, args: string[], onProgress?: ProgressCallback): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(podmanBin, args, {
        env: this.getExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          log.debug(`[ContainerService] [build] ${line}`);
          onProgress?.('build', line);
        }
      });

      const stderrLines: string[] = [];

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          log.debug(`[ContainerService] [build stderr] ${line}`);
          stderrLines.push(line);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          log.debug('[ContainerService] Build completed successfully');
          resolve();
        } else {
          const lastLines = stderrLines.slice(-5).join('\n');
          reject(new Error(`podman build exited with code ${code}${lastLines ? ': ' + lastLines : ''}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to build container image: ${error.message}`));
      });
    });
  }

  // ─── Container Lifecycle ──────────────────────────────────────

  private async removeStaleContainer(podmanBin: string): Promise<void> {
    const env = this.getExecEnv();

    // Check if a container with this name exists at all
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'inspect', '--format', '{{.State.Status}}', CONTAINER_NAME,
      ], env);
      log.debug(`[ContainerService] Found existing container in state: ${stdout.trim()}`);
    } catch {
      log.debug('[ContainerService] No existing container found');
      return;
    }

    // Stop and remove it
    try {
      await this.execAsync(podmanBin, ['rm', '-f', CONTAINER_NAME], env);
      log.debug('[ContainerService] Removed existing container');
    } catch (error) {
      log.error('[ContainerService] Failed to remove container:', (error as Error).message);
    }
  }

  private hostGatewayIp: string | null = null;

  /**
   * Get the IP address the container can use to reach the host.
   * Detected after container start by querying the default gateway from inside.
   */
  getHostGatewayIp(): string | null {
    return this.hostGatewayIp;
  }

  private async runContainer(podmanBin: string, workspacePath: string, imageName?: string): Promise<void> {
    const env = this.getExecEnv();
    const mountPath = toMountPath(workspacePath);

    // Find a free host port for the agent server (container exposes 8080)
    const agentHostPort = await findFreePort(23300, 23320);
    this.agentPort = agentHostPort;

    const useImage = imageName || IMAGE_NAME;
    const useOverlay = process.platform === 'darwin';
    this.overlayEnabled = useOverlay;

    const args = useOverlay ? [
      'run', '-d',
      '--replace',
      '--privileged',
      '--name', CONTAINER_NAME,
      '-v', `${mountPath}:/data-host`,
      '-p', `${agentHostPort}:8080`,
      useImage,
      'sh', '-c',
      // The container rootfs is itself overlay (podman storage driver), so
      // upper/work dirs can't live on it. Mount a tmpfs first.
      'mount -t tmpfs tmpfs /tmp -o size=4G && ' +
      'mkdir -p /tmp/overlay-upper /tmp/overlay-work && ' +
      'mount -t overlay overlay -o lowerdir=/data-host,upperdir=/tmp/overlay-upper,workdir=/tmp/overlay-work /data && ' +
      '(command -v rsync >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq rsync >/dev/null 2>&1)) && ' +
      'sleep infinity',
    ] : [
      'run', '-d',
      '--replace',
      '--name', CONTAINER_NAME,
      '-v', `${mountPath}:/data`,
      '-p', `${agentHostPort}:8080`,
      useImage,
      'sleep', 'infinity',
    ];

    log.debug(`[ContainerService] Running: podman ${args.join(' ')}`);

    const { stdout } = await this.execAsync(podmanBin, args, env);
    const containerId = stdout.trim().substring(0, 12);
    log.debug(`[ContainerService] Container started with ID: ${containerId}`);

    // Verify the mount is correct
    try {
      const mountDest = useOverlay ? '/data-host' : '/data';
      const { stdout: mountSource } = await this.execAsync(podmanBin, [
        'inspect', '--format', `{{range .Mounts}}{{if eq .Destination "${mountDest}"}}{{.Source}}{{end}}{{end}}`, CONTAINER_NAME,
      ], env);
      log.debug(`[ContainerService] Container ${mountDest} mount source: ${mountSource.trim()}`);
      if (useOverlay) {
        log.info('[ContainerService] OverlayFS enabled — writes go to container-local storage');
      }
    } catch (err) {
      log.warn(`[ContainerService] Could not verify mount: ${(err as Error).message}`);
    }

    // Detect the host IP so the container can reach host services (MCP proxy).
    // On macOS, podman runs containers inside a VM. The container network gateway
    // (10.88.0.x) only reaches the VM, not the macOS host. We need the VM's own
    // gateway, which IS the macOS host (typically 192.168.127.1 for gvproxy).
    try {
      if (process.platform === 'darwin' || process.platform === 'win32') {
        // Query the VM's default route to find the real host IP
        const { stdout: vmRoute } = await this.execAsync(podmanBin, [
          'machine', 'ssh', '--', 'ip', 'route', 'show', 'default',
        ], env);
        // Output: "default via 192.168.127.1 dev enp0s1 ..."
        const match = vmRoute.match(/default via ([\d.]+)/);
        this.hostGatewayIp = match?.[1] || null;
      } else {
        // On Linux, containers can reach the host directly via the container gateway
        const { stdout: gatewayIp } = await this.execAsync(podmanBin, [
          'inspect', '--format', '{{.NetworkSettings.Gateway}}', CONTAINER_NAME,
        ], env);
        this.hostGatewayIp = gatewayIp.trim() || null;
      }
      log.info(`[ContainerService] Host gateway IP: ${this.hostGatewayIp}`);
    } catch (err) {
      log.warn(`[ContainerService] Could not detect gateway IP: ${(err as Error).message}`);
      this.hostGatewayIp = null;
    }

    this.containerStarted = true;
    this.currentWorkspacePath = workspacePath;

    // Wait for the overlay mount to be ready before returning — podman run -d
    // returns immediately but the inline sh -c (mkdir, mount, rsync install)
    // hasn't finished yet.
    if (useOverlay) {
      const startWait = Date.now();
      const timeoutMs = 30_000;
      while (Date.now() - startWait < timeoutMs) {
        try {
          const { stdout } = await this.execAsync(podmanBin, [
            'exec', CONTAINER_NAME, 'sh', '-c', 'mount | grep "on /data type overlay"',
          ], env);
          if (stdout.trim()) {
            log.info(`[ContainerService] Overlay mount ready (${Date.now() - startWait}ms)`);
            break;
          }
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    this.startLogTail(podmanBin);
    this.startHealthWatch(podmanBin);
  }

  // ─── OverlayFS Sync ──────────────────────────────────────────

  isOverlayEnabled(): boolean {
    return this.overlayEnabled;
  }

  async syncOverlay(): Promise<{ durationMs: number }> {
    if (!this.overlayEnabled || !this.isRunning()) {
      throw new Error('Overlay sync not available — overlay not enabled or container not running');
    }
    const start = Date.now();
    await this.exec([
      'rsync', '-a', '--delete',
      '--exclude', '.academia/claude',
      '--exclude', '.academia/agent-server.js',
      '--exclude', '.academia/agent.json',
      '--exclude', 'node_modules/.cache',
      '/data/', '/data-host/',
    ]);
    const durationMs = Date.now() - start;
    log.info(`[ContainerService] Overlay synced in ${durationMs}ms`);
    return { durationMs };
  }

  async writeContentToContainer(content: string, containerPath: string): Promise<void> {
    const tmpFile = path.join(os.tmpdir(), `_podman_cp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    try {
      fs.writeFileSync(tmpFile, content, 'utf-8');
      await this.podmanCp(tmpFile, containerPath);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
    }
  }

  private async podmanCp(hostPath: string, containerPath: string): Promise<void> {
    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();
    const tmpPath = `/tmp/_podman_cp_${Date.now()}`;
    await this.execAsync(podmanBin, [
      'cp', hostPath, `${CONTAINER_NAME}:${tmpPath}`,
    ], env);
    const dir = containerPath.substring(0, containerPath.lastIndexOf('/'));
    await this.exec(['sh', '-c', `mkdir -p ${dir} && mv ${tmpPath} ${containerPath}`]);
  }

  // ─── Container Log Tailing ───────────────────────────────────

  private startLogTail(podmanBin: string): void {
    this.stopLogTail();
    this.lastLogTime = new Date().toISOString();
    this.logTailInterval = setInterval(async () => {
      try {
        const { stdout, stderr } = await this.execAsync(podmanBin, [
          'logs', '--since', this.lastLogTime, CONTAINER_NAME,
        ], this.getExecEnv());
        this.lastLogTime = new Date().toISOString();
        const output = (stdout + stderr).trim();
        if (output) {
          for (const line of output.split('\n')) {
            log.debug(`[Container] ${line}`);
          }
        }
      } catch {
        // Container may have stopped
      }
    }, 5000);
  }

  private stopLogTail(): void {
    if (this.logTailInterval) {
      clearInterval(this.logTailInterval);
      this.logTailInterval = null;
    }
  }

  // ─── Container Health Watch ──────────────────────────────────

  private startHealthWatch(podmanBin: string): void {
    this.stopHealthWatch();
    this.healthCheckInterval = setInterval(async () => {
      if (!this.containerStarted || this.isStarting || !this.currentWorkspacePath) return;

      let running = false;
      try {
        const { stdout } = await this.execAsync(podmanBin, [
          'inspect', '--format', '{{.State.Running}}', CONTAINER_NAME,
        ], this.getExecEnv());
        running = stdout.trim() === 'true';
      } catch {
        running = false;
      }

      if (!running) {
        log.warn('[ContainerService] Container stopped unexpectedly, restarting...');
        this.isStarting = true;
        try {
          await this.runContainer(podmanBin, this.currentWorkspacePath);
          log.info('[ContainerService] Container restarted successfully');
        } catch (err) {
          log.error('[ContainerService] Auto-restart failed:', (err as Error).message);
        } finally {
          this.isStarting = false;
        }
      }
    }, 10_000);
  }

  private stopHealthWatch(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // ─── Utilities ────────────────────────────────────────────────

  private execAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { env, timeout: 120000 }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  }

  private spawnAndWait(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stderrLines: string[] = [];

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) log.debug(`[ContainerService] [${label}] ${line}`);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          log.debug(`[ContainerService] [${label} stderr] ${line}`);
          stderrLines.push(line);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          // Check for critical errors on stderr even when exit code is 0
          // (e.g., socket bind failures during machine start)
          const criticalError = stderrLines.find(l => l.includes('level=error'));
          if (criticalError) {
            log.error(`[ContainerService] ${label} exited 0 but had errors: ${criticalError}`);
            reject(new Error(`podman ${label} reported an error: ${criticalError}`));
          } else {
            log.debug(`[ContainerService] ${label} completed successfully`);
            resolve();
          }
        } else {
          const stderrSummary = stderrLines.slice(-3).join('\n');
          reject(new Error(`podman ${label} exited with code ${code}${stderrSummary ? ': ' + stderrSummary : ''}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to run podman ${label}: ${error.message}`));
      });
    });
  }
}

export const containerService = new CobuildingContainerService();
