import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import log from 'electron-log';
import {
  getBundledPodmanBin,
  getBundledPodmanBinIfExists,
  getBundledPodmanBinDir,
  getBundledPodmanEnv,
  ensureBinariesDownloaded,
} from './podmanBinaries';
import { commandLogger, parseAppDirFromArgs, type CommandSource } from './commandLogger';
import { ensureImageTarDownloaded, writeLoadedImageVersion, readLoadedImageVersion } from './imageTarManager';
import { captureError } from '../shared/telemetry';

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
const CORE_BASE_IMAGE = 'cobuilding-base-core:local';
const IMAGE_NAME = 'cobuilding-container';
const CONTAINER_NAME = 'cobuilding-container';

export function useLocalImage(): boolean {
  return process.env.COBUILDING_REGISTRY_IMAGE !== '1';
}

export function getImageTier(): 'core' | 'full' {
  if (process.env.COBUILDING_IMAGE_TIER === 'full') return 'full';
  if (process.env.COBUILDING_IMAGE_TIER === 'core') return 'core';
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    if (data.imageTier === 'full') return 'full';
  } catch { /* file doesn't exist yet */ }
  return 'core';
}

export function writeImageTier(tier: 'core' | 'full'): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { /* file doesn't exist yet */ }
  data.imageTier = tier;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

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

const VM_MEMORY_MB = 2048;
const VM_CPUS = 2;
const NODE_HEAP_MB = 1536;
const OOM_WARNING_MB = 1638;
const TMPFS_SIZE_GB = 1;

class CobuildingContainerService {
  private containerStarted = false;
  private isStarting = false;
  private currentAgentDir: string | null = null;
  private currentMountMap: Array<{ hostPath: string; containerPath: string }> = [];
  private logTailInterval: ReturnType<typeof setInterval> | null = null;
  private lastLogTime: string = new Date().toISOString();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private agentPort: number | null = null;
  private kernelPort: number | null = null;
  private kernelStartPromise: Promise<void> | null = null;

  // Host-side handles to the `podman exec` wrappers for the in-container
  // processes. Tracking them lets us kill the wrapper when we retry or stop,
  // so failed starts don't leak processes on the main host.
  private kernelGatewayProc: ChildProcess | null = null;
  private agentServerProc: ChildProcess | null = null;
  private depTrackingProc: ChildProcess | null = null;

  // Health-watch restart accounting. Reset whenever the container itself is
  // (re)started, so a freshly-recovered container gets a fresh budget.
  // The cap exists to avoid spinning forever on a genuinely-broken service
  // (missing binary, persistent port conflict, OOM loop) and silently
  // leaking podman-exec wrappers on each retry.
  private kernelGatewayRestartAttempts = 0;
  private agentServerConsecutiveFailures = 0;
  private agentServerRestartAttempts = 0;

  // Cached agent-server start params so the watchdog can revive a dead
  // agent server without the renderer having to re-fire setup IPC. Cleared
  // by explicit stops (workspace switch, logout, quit) so we never restart
  // an agent the user has intentionally torn down.
  private lastAgentServerConfig: string | null = null;
  private lastAgentServerWorkspacePath: string | null = null;

  // Surface the latest kernel-gateway failure so the renderer can show a
  // meaningful error after an eager-start failure (the renderer otherwise
  // only learns of it by trying to open a mini-app).
  private lastKernelGatewayError: string | null = null;

  private overlayEnabled = false;
  private activeSyncPromise: Promise<{ durationMs: number }> | null = null;
  private overlaySyncInterval: ReturnType<typeof setInterval> | null = null;
  private memoryPollTimer: ReturnType<typeof setInterval> | null = null;
  private stoppingContainer = false;

  // ─── Public API ─────────────────────────────────────────────────

  async start(
    mountMap: Array<{ hostPath: string; containerPath: string }>,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const mountMapChanged = JSON.stringify(mountMap) !== JSON.stringify(this.currentMountMap);
    if (this.isRunning() && !mountMapChanged) {
      return;
    }
    if (this.isStarting) {
      return;
    }

    // If running with different mounts, stop the old container first
    if (this.isRunning() && mountMapChanged) {
      log.debug(`[ContainerService] Mount map changed, restarting container...`);
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

      const baseImage = this.getBaseImageRef();
      log.info(`[ContainerService] Starting from base image (${baseImage})`);
      await this.runContainer(podmanBin, mountMap, baseImage);
      void this.pruneImages(podmanBin);

      log.debug('[ContainerService] Container started successfully');
      void this.logDiskUsage('post-start');
      await this.bootstrapPipSite(podmanBin);
      onProgress?.('ready', 'Container ready');
    } catch (error) {
      log.error('[ContainerService] Error:', (error as Error).message);
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  stop(): void {
    this.stopPeriodicSync();
    this.stopLogTail();
    this.stopHealthWatch();

    const podmanBin = this.getPodmanBinIfExists();

    if (!podmanBin) {
      log.debug('[ContainerService] Podman binary not available, skipping container stop commands');
      this.containerStarted = false;
      this.currentAgentDir = null;
      this.currentMountMap = [];
      this.overlayEnabled = false;
      return;
    }

    this.collectDepUsage(podmanBin);
    this.stopDepTracking();

    this.stoppingContainer = true;
    log.debug('[ContainerService] Stopping container...');

    // Kill host-side podman-exec wrappers up front so they don't outlive
    // the container they're attached to and become orphans.
    this.killProc('kernelGatewayProc');
    this.killProc('agentServerProc');

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
          '--exclude', '.applications/_environment',
          '/data/', '/data-host/',
        ], { env, timeout: 60_000 });
        log.info('[ContainerService] Overlay sync complete');
      } catch (err) {
        log.warn(`[ContainerService] Overlay sync failed: ${(err as Error).message}`);
      }
    }

    try {
      execFileSync(podmanBin, ['stop', '-t', '3', CONTAINER_NAME], { env, timeout: 10000, stdio: 'ignore' });
      log.debug('[ContainerService] Container stopped');
    } catch {
      log.debug('[ContainerService] Container was not running or already stopped');
    }

    try {
      execFileSync(podmanBin, ['rm', '-f', CONTAINER_NAME], { env, timeout: 5000, stdio: 'ignore' });
      log.debug('[ContainerService] Container removed');
    } catch {
      // Already removed
    }

    try {
      execFileSync(podmanBin, ['machine', 'stop'], { env, timeout: 120_000, stdio: 'ignore' });
      log.debug('[ContainerService] VM stopped');
    } catch (err) {
      log.warn(`[ContainerService] VM stop: ${(err as Error).message}`);
    }

    this.containerStarted = false;
    this.currentAgentDir = null;
    this.currentMountMap = [];
    this.agentPort = null;
    this.kernelPort = null;
    this.kernelStartPromise = null;
    this.lastAgentServerConfig = null;
    this.lastAgentServerWorkspacePath = null;
    this.lastKernelGatewayError = null;
    this.kernelGatewayRestartAttempts = 0;
    this.agentServerConsecutiveFailures = 0;
    this.agentServerRestartAttempts = 0;
    this.overlayEnabled = false;
  }

  /**
   * Stop the Podman machine after the container is gone so host-side image
   * cache files are not held by the VM (used before clearing download artifacts).
   */
  stopPodmanMachineBestEffort(): void {
    const podmanBin = this.getPodmanBinIfExists();
    if (!podmanBin) {
      log.debug('[ContainerService] No podman binary for machine stop');
      return;
    }
    const env = this.getExecEnv();
    try {
      execFileSync(podmanBin, ['machine', 'stop'], { env, timeout: 120_000, stdio: 'ignore' });
      log.info('[ContainerService] podman machine stop finished');
    } catch (err) {
      log.warn(`[ContainerService] podman machine stop: ${(err as Error).message}`);
    }
  }

  /** Best-effort SIGTERM on a tracked child process, clearing the handle. */
  private killProc(field: 'kernelGatewayProc' | 'agentServerProc'): void {
    const proc = this[field];
    if (!proc) return;
    this[field] = null;
    try {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
      }
    } catch (err) {
      log.debug(`[ContainerService] killProc(${field}) ignored:`, (err as Error).message);
    }
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

      proc.on('close', (code, signal) => {
        // If the process was killed by a signal (e.g., container stop killed
        // the in-flight pip exec), report a non-zero exit so callers can't
        // mistake it for success and mark packages as installed.
        if (code === null) {
          log.warn(`[ContainerService] execStreaming killed by signal ${signal} during: ${command.join(' ')}`);
          resolve({ exitCode: 1 });
          return;
        }
        resolve({ exitCode: code });
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

  getContainerName(): string {
    return CONTAINER_NAME;
  }

  getPodmanEnv(): NodeJS.ProcessEnv {
    return this.getExecEnv();
  }

  getAgentPort(): number | null {
    return this.agentPort;
  }

  getKernelPort(): number | null {
    return this.kernelPort;
  }

  getKernelGatewayUrl(): string | null {
    return this.kernelPort ? `http://localhost:${this.kernelPort}` : null;
  }

  getLastKernelGatewayError(): string | null {
    return this.lastKernelGatewayError;
  }

  /**
   * Copy the agent server bundle and Linux claude binary to the workspace mount.
   * The binary is only re-copied when its size changes (new SDK version).
   */
  async ensureAgentFilesInWorkspace(agentControlledDir: string): Promise<void> {
    const agentDir = path.join(agentControlledDir, '.academia');
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
  async startAgentServer(configJson: string, agentDir: string): Promise<void> {
    // Cache params so the health-watch watchdog can revive the server if it
    // dies later. Cached params are cleared by stopAgentServer and stop(), so
    // an intentional teardown never auto-restarts.
    this.lastAgentServerConfig = configJson;
    this.lastAgentServerWorkspacePath = agentDir;

    if (await this.isAgentServerHealthy()) {
      log.debug('[ContainerService] Agent server already healthy — skipping restart');
      return;
    }

    // Kill any existing (unhealthy / orphaned) agent server first. Pass
    // `preserveCache: true` so this call doesn't blow away the params we
    // just cached for the watchdog.
    await this.stopAgentServer({ preserveCache: true });

    // Write config to workspace
    if (this.overlayEnabled) {
      await this.writeContentToContainer(configJson, '/data/.academia/agent.json');
    } else {
      const configPath = path.join(agentDir, '.academia', 'agent.json');
      fs.writeFileSync(configPath, configJson, 'utf-8');
    }

    // Start the server inside the container (non-detached so we can capture output)
    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();
    const proc = spawn(podmanBin, [
      'exec',
      '-e', 'COBUILDING_INSIDE_CONTAINER=1',
      CONTAINER_NAME,
      'node', `--max-old-space-size=${NODE_HEAP_MB}`, '/data/.academia/agent-server.js',
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.agentServerProc = proc;

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
      // Only clear the handle if it's still pointing at this process —
      // a later start may have already replaced it.
      if (this.agentServerProc === proc) this.agentServerProc = null;
      if ((signal === 'SIGKILL' || code === 137) && !this.stoppingContainer) {
        log.error('[AgentServer] Process was OOM-killed (code=137/SIGKILL). Consider increasing --memory or --max-old-space-size.');
      }
      if (this.memoryPollTimer) {
        clearInterval(this.memoryPollTimer);
        this.memoryPollTimer = null;
      }
    });

    // Wait for the health endpoint to respond (up to 10 seconds)
    const agentPort = this.agentPort;
    if (!agentPort) {
      log.error('[ContainerService] No agent port assigned');
      this.killProc('agentServerProc');
      throw new Error('Agent server has no port assigned');
    }

    const startTime = Date.now();
    const timeoutMs = 10_000;
    while (Date.now() - startTime < timeoutMs) {
      if (await this.isAgentServerHealthy(2000)) {
        log.info('[ContainerService] Agent server healthy');
        this.startMemoryPolling();
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    log.error('[ContainerService] Agent server failed to become healthy within 10s');
    this.killProc('agentServerProc');
    throw new Error('Agent server failed to become healthy within 10s');
  }

  private startMemoryPolling(): void {
    if (this.memoryPollTimer) clearInterval(this.memoryPollTimer);
    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();
    this.memoryPollTimer = setInterval(async () => {
      try {
        const { stdout } = await this.execAsync(podmanBin, [
          'exec', CONTAINER_NAME,
          'ps', '-eo', 'pid,rss,args', '--sort=-rss', '--no-headers',
        ], env);
        const lines = stdout.trim().split('\n').filter(Boolean);
        let totalMB = 0;
        const procs: string[] = [];
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 3) continue;
          const rssKB = parseInt(parts[1], 10);
          if (isNaN(rssKB) || rssKB < 1024) continue;
          const rssMB = Math.round(rssKB / 1024);
          const args = parts.slice(2).join(' ');
          const label = args.length > 60 ? args.slice(0, 60) + '…' : args;
          totalMB += rssMB;
          procs.push(`${label}=${rssMB}MB`);
        }
        if (procs.length > 0) {
          log.info(`[Container:Memory] total=${totalMB}MB | ${procs.join(', ')}`);
          if (totalMB > OOM_WARNING_MB) {
            log.warn(`[Container:Memory] Usage above ${OOM_WARNING_MB}MB (${totalMB}MB) — OOM risk`);
          }
        }
      } catch { /* container not running */ }
    }, 60_000);
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

  async updateAgentCredentials(apiKey: string, baseURL?: string): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;

    const ok = await new Promise<boolean>((resolve) => {
      const payload = JSON.stringify({ anthropicApiKey: apiKey, anthropicBaseURL: baseURL ?? '' });
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/credentials',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000,
      }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    });

    if (ok && this.lastAgentServerConfig) {
      try {
        const parsed = JSON.parse(this.lastAgentServerConfig);
        parsed.anthropicApiKey = apiKey;
        if (baseURL) {
          parsed.anthropicBaseURL = baseURL;
        } else {
          delete parsed.anthropicBaseURL;
        }
        this.lastAgentServerConfig = JSON.stringify(parsed, null, 2);
      } catch { /* best-effort cache update */ }
    }

    return ok;
  }

  /**
   * Stop the agent server process inside the container.
   *
   * Logs a stack trace on every invocation so that if a running session is
   * unexpectedly killed mid-task ([AgentServer] Process exited code=0
   * signal=null), we can see exactly which caller fired pkill — most likely
   * a re-entrant startAgentServer() (re-init) or a stray container:stop.
   */
  async stopAgentServer(options?: { preserveCache?: boolean }): Promise<void> {
    const trace = new Error('stopAgentServer call site').stack;
    log.warn(`[ContainerService] stopAgentServer invoked\n${trace}`);
    // Kill the host-side wrapper first; otherwise it lingers until the
    // container goes away (and the wrapper would be the prime suspect for
    // the "exited code=0 signal=null" crashes the trace log was added to
    // diagnose).
    this.killProc('agentServerProc');
    if (this.memoryPollTimer) {
      clearInterval(this.memoryPollTimer);
      this.memoryPollTimer = null;
    }
    try {
      await this.exec(['pkill', '-f', 'agent-server.js']);
    } catch {
      // Process may not be running
    }
    // Default: any explicit stop disables the watchdog so we don't fight
    // the user's teardown. startAgentServer passes preserveCache: true to
    // keep the cache during its own restart sequence.
    if (!options?.preserveCache) {
      this.lastAgentServerConfig = null;
      this.lastAgentServerWorkspacePath = null;
      this.agentServerConsecutiveFailures = 0;
      this.agentServerRestartAttempts = 0;
    }
    log.debug('[ContainerService] Agent server stopped');
  }

  /**
   * Start the Jupyter kernel gateway inside the container. Idempotent: if
   * the gateway already responds on the assigned port, returns without doing
   * anything. Concurrent callers share the in-flight start promise.
   *
   * Output is piped through electron-log at info/warn levels — kernel
   * activity ends up in the debug panel's Logs tab (via the systemLogger
   * transport) and the main.log file. Source-side noise is reduced with
   * --KernelGatewayApp.log_level=WARN.
   */
  async startKernelGateway(): Promise<void> {
    if (this.kernelStartPromise) {
      return this.kernelStartPromise;
    }
    if (await this.isKernelGatewayHealthy()) {
      log.debug('[ContainerService] Kernel gateway already healthy — skipping start');
      this.lastKernelGatewayError = null;
      return;
    }

    this.kernelStartPromise = this._startKernelGateway();
    try {
      await this.kernelStartPromise;
      this.lastKernelGatewayError = null;
    } catch (err) {
      this.lastKernelGatewayError = (err as Error).message;
      throw err;
    } finally {
      this.kernelStartPromise = null;
    }
  }

  private async _startKernelGateway(): Promise<void> {
    // Kill any unhealthy / orphaned gateway first — both the in-container
    // process (via pkill) and the host-side wrapper we may have spawned
    // ourselves on a previous attempt.
    await this.stopKernelGateway();

    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();
    const proc = spawn(podmanBin, [
      'exec',
      CONTAINER_NAME,
      'jupyter', 'kernelgateway',
      '--KernelGatewayApp.api=kernel_gateway.jupyter_websocket',
      '--KernelGatewayApp.ip=0.0.0.0',
      '--KernelGatewayApp.port=8888',
      '--KernelGatewayApp.allow_origin=*',
      '--KernelGatewayApp.log_level=WARN',
      // Gateway listens on 8888 inside the container, reachable only via the
      // host-bound port-forward. Both ends are local, so disable cookie/token
      // auth — otherwise the renderer's stale cookies (signed by a previous
      // gateway process) get 403'd on every restart.
      '--KernelGatewayApp.auth_token=',
      '--ServerApp.token=',
      '--ServerApp.password=',
      '--ServerApp.disable_check_xsrf=True',
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.kernelGatewayProc = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.info(`[KernelGateway] ${line}`);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.warn(`[KernelGateway] ${line}`);
      }
    });
    proc.on('exit', (code, signal) => {
      log.warn(`[KernelGateway] Process exited (code=${code}, signal=${signal})`);
      if (this.kernelGatewayProc === proc) this.kernelGatewayProc = null;
    });

    const kernelPort = this.kernelPort;
    if (!kernelPort) {
      this.killProc('kernelGatewayProc');
      throw new Error('Kernel gateway has no port assigned');
    }

    const startTime = Date.now();
    const timeoutMs = 15_000;
    while (Date.now() - startTime < timeoutMs) {
      if (await this.isKernelGatewayHealthy(2000)) {
        log.info(`[ContainerService] Kernel gateway healthy at http://localhost:${kernelPort}`);
        return;
      }
      // If the wrapper has already died, no amount of polling will help —
      // surface that immediately rather than waiting out the full timeout.
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(
          `Kernel gateway process exited before becoming healthy (code=${proc.exitCode}, signal=${proc.signalCode})`,
        );
      }
      await new Promise(r => setTimeout(r, 250));
    }

    this.killProc('kernelGatewayProc');
    throw new Error('Kernel gateway failed to become healthy within 15s');
  }

  /** One-shot probe of /api/kernelspecs. Returns true iff the gateway responds 200. */
  private async isKernelGatewayHealthy(timeoutMs = 1500): Promise<boolean> {
    const port = this.kernelPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/api/kernelspecs',
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
   * Stop the Jupyter kernel gateway process inside the container.
   * Does NOT touch the container itself — leaves it running so the agent
   * server stays up.
   */
  async stopKernelGateway(): Promise<void> {
    // Host-side wrapper first — otherwise it lingers (and on a retry, the
    // health-watch path would spawn another one, leaking under repeated
    // failures).
    this.killProc('kernelGatewayProc');
    try {
      await this.exec(['pkill', '-f', 'kernelgateway']);
    } catch {
      // Process may not be running, or container is down
    }
    log.debug('[ContainerService] Kernel gateway stopped');
  }

  writeStartContainerScript(mountMap: Array<{ hostPath: string; containerPath: string }>): void {
    const agentDir = mountMap[0]?.hostPath;
    if (!agentDir) return;
    const academiaDir = path.join(agentDir, '.academia');
    fs.mkdirSync(academiaDir, { recursive: true });
    const scriptPath = path.join(academiaDir, 'start-container');

    // Compute the podman binary path without requiring it to exist yet
    // (binaries may not be downloaded until the user starts the container).
    const podmanBin = this.useBundled()
      ? path.join(getBundledPodmanBinDir(), process.platform === 'win32' ? 'podman.exe' : 'podman')
      : 'podman';

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

    const volumeFlags = mountMap
      .map(m => `  -v "${toMountPath(m.hostPath)}:${m.containerPath}" \\`)
      .join('\n');

    const script = [
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      `CONTAINER_NAME="${CONTAINER_NAME}"`,
      `IMAGE_NAME="${IMAGE_NAME}"`,
      '',
      envExports +
        '# If the container is already running, there is nothing to do.',
      `if "${podmanBin}" inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q '^true$'; then`,
      '  echo "Container is already running."',
      '  exit 0',
      'fi',
      '',
      'echo "Starting $CONTAINER_NAME..."',
      `"${podmanBin}" run -d \\`,
      '  --replace \\',
      '  --name "$CONTAINER_NAME" \\',
      volumeFlags,
      '  -p 23300:8080 \\',
      '  -p 23330:8888 \\',
      '  "$IMAGE_NAME" \\',
      '  sleep infinity',
      '',
      '# Wait up to 30 seconds for the container to become running.',
      'for i in $(seq 1 30); do',
      `  if "${podmanBin}" inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q '^true$'; then`,
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
      captureError(error, { subsystem: 'container' });
      throw error;
    }

    onProgress?.('setup-done', 'Setup complete');
  }

  /** Whether the base image is present locally. */
  async isBaseImageDownloaded(): Promise<boolean> {
    try {
      const { stdout } = await this.execAsync(this.getPodmanBin(), [
        'image', 'inspect', '--format', '{{.Id}}', this.getBaseImageRef(),
      ], this.getExecEnv());
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private useBundled(): boolean {
    return readBinaryMode() === 'bundled';
  }

  private getBaseImageRef(): string {
    if (readImageSource() === 'local') return LOCAL_BASE_IMAGE;
    if (useLocalImage()) {
      return getImageTier() === 'core' ? CORE_BASE_IMAGE : GHCR_BASE_IMAGE;
    }
    return GHCR_BASE_IMAGE;
  }

  // ─── Podman Binary Resolution ──────────────────────────────────

  private getPodmanBin(): string {
    if (this.useBundled()) {
      return getBundledPodmanBin();
    }
    return 'podman';
  }

  private getPodmanBinIfExists(): string | null {
    if (this.useBundled()) {
      return getBundledPodmanBinIfExists();
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
      log.debug(`[ContainerService] Machine not initialized, running podman machine init (memory=${VM_MEMORY_MB}MB, cpus=${VM_CPUS})...`);
      await this.spawnAndWait(podmanBin, [
        'machine', 'init', '--user-mode-networking', '--memory', String(VM_MEMORY_MB), '--cpus', String(VM_CPUS),
      ], env, 'machine init');
    }

    const running = await this.isMachineRunning(podmanBin, env);
    if (!running) {
      onProgress?.('start-machine', 'Starting Podman VM...');
      log.debug('[ContainerService] Machine not running, starting...');
      await this.startMachineIdempotent(podmanBin, env);
    }

    // Verify the API socket is actually responsive. podman machine list
    // reads the machine config (which has the correct port) but the CLI
    // connects via the connection config (podman-connections.json) which
    // can have a stale SSH port after restarts or upgrades.
    const socketReady = await this.waitForSocket(podmanBin, env, running ? 8 : 15, 3000);

    if (!socketReady) {
      log.warn('[ContainerService] Podman socket unresponsive, restarting machine to refresh connection config...');
      onProgress?.('start-machine', 'Podman VM unresponsive, restarting...');

      try {
        await this.spawnAndWait(podmanBin, ['machine', 'stop'], env, 'machine stop');
      } catch (stopErr) {
        log.warn('[ContainerService] Machine stop during recovery failed:', (stopErr as Error).message);
      }

      onProgress?.('start-machine', 'Restarting Podman VM...');
      await this.startMachineIdempotent(podmanBin, env);

      const readyAfterRestart = await this.waitForSocket(podmanBin, env, 15, 3000);
      if (!readyAfterRestart) {
        throw new Error(
          'Podman VM started but API socket is not responding. ' +
          'Try resetting the Podman VM in Settings or restarting the application.'
        );
      }
      log.info('[ContainerService] Machine recovered — connection config refreshed by machine start');
    }

    if (useLocalImage()) {
      await this.configureVmImageTmpDir(podmanBin, env);
    }
  }

  private async configureVmImageTmpDir(podmanBin: string, env: NodeJS.ProcessEnv): Promise<void> {
    const hostTmpDir = path.join(os.homedir(), '.cobuild-tmp');
    fs.mkdirSync(hostTmpDir, { recursive: true });

    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'machine', 'ssh', '--', 'cat', '/etc/containers/containers.conf',
      ], env);
      if (stdout.includes('image_copy_tmp_dir')) {
        log.debug('[ContainerService] image_copy_tmp_dir already configured in VM');
        return;
      }
    } catch {
      // File doesn't exist or SSH failed — proceed to write
    }

    try {
      await this.execAsync(podmanBin, [
        'machine', 'ssh', '--', 'sh', '-c',
        `printf '[engine]\\nimage_copy_tmp_dir = "${hostTmpDir}"\\n' | sudo tee /etc/containers/containers.conf > /dev/null`,
      ], env);
      log.info(`[ContainerService] Configured image_copy_tmp_dir = ${hostTmpDir}`);
    } catch (err) {
      log.warn(`[ContainerService] Failed to configure image_copy_tmp_dir: ${(err as Error).message}`);
    }
  }

  // `podman machine start` exits 125 with "VM already running or starting"
  // when another caller is already starting (or has just started) the VM.
  // That's the state we want, so treat it as success. Happens in practice when
  // multiple renderer windows each fire ensureSetup() concurrently.
  private async startMachineIdempotent(podmanBin: string, env: NodeJS.ProcessEnv): Promise<void> {
    try {
      await this.spawnAndWait(podmanBin, ['machine', 'start'], env, 'machine start');
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('VM already running or starting')) {
        log.info('[ContainerService] machine start: VM already running or starting — treating as success');
        return;
      }
      throw err;
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

  private async ensureBaseImageLoaded(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const tier = getImageTier();
    const { tarPath, version } = await ensureImageTarDownloaded(tier, onProgress);

    const loadedVersion = readLoadedImageVersion(tier);
    const imageRef = this.getBaseImageRef();
    const imagePresent = await this.imageExists(podmanBin, imageRef);
    if (loadedVersion === version && imagePresent) {
      log.debug(`[ContainerService] Image already loaded (version: ${version})`);
      return;
    }

    onProgress?.('load', 'Loading image into Podman VM...');
    log.debug(`[ContainerService] Loading image from tar: ${tarPath}`);

    await this.spawnAndWait(podmanBin, ['load', '-i', tarPath], this.getExecEnv(), 'image load');

    writeLoadedImageVersion(tier, version);
    log.info(`[ContainerService] Image loaded successfully (version: ${version})`);

    onProgress?.('load', 'Image loaded', 100);
  }

  async updateBaseImage(onProgress?: ProgressCallback): Promise<void> {
    if (useLocalImage()) {
      const podmanBin = this.getPodmanBin();
      await this.ensureBaseImageLoaded(podmanBin, onProgress);
      log.debug('[ContainerService] Base image updated (local tar)');
      return;
    }
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

  /** Ensure the base image is available (load from tar, pull from registry, or build locally). */
  private async ensureBaseImage(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const imageSource = readImageSource();
    if (imageSource === 'local') {
      await this.buildBaseImageLocally(podmanBin, onProgress);
    } else if (!useLocalImage()) {
      await this.ensureBaseImagePulled(podmanBin, onProgress);
    } else {
      await this.ensureBaseImageLoaded(podmanBin, onProgress);
    }
  }

  private getDockerfileBaseHash(): string {
    const contextDir = this.getDockerfileDir();
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(path.join(contextDir, 'Dockerfile.base')));
    return hash.digest('hex').substring(0, 16);
  }

  private async getLocalBaseImageHash(podmanBin: string): Promise<string | null> {
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{index .Config.Labels "dockerfile.base.hash"}}', LOCAL_BASE_IMAGE,
      ], this.getExecEnv());
      const hash = stdout.trim();
      return hash && hash !== '<no value>' ? hash : null;
    } catch {
      return null;
    }
  }

  private async buildBaseImageLocally(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const currentHash = this.getDockerfileBaseHash();

    // Rebuild only if the image is missing OR its labelled hash doesn't
    // match the current Dockerfile.base. Without this, edits to
    // Dockerfile.base (e.g. adding tini, switching the entrypoint) wouldn't
    // trigger a local rebuild and the dev would silently keep running a
    // stale image.
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{.Id}}', LOCAL_BASE_IMAGE,
      ], this.getExecEnv());
      if (stdout.trim().length > 0) {
        const imageHash = await this.getLocalBaseImageHash(podmanBin);
        if (imageHash === currentHash) {
          log.debug('[ContainerService] Local base image already built and up to date');
          return;
        }
        log.info(`[ContainerService] Local base image stale (${imageHash ?? 'unlabeled'} → ${currentHash}), rebuilding...`);
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
      '--label', `dockerfile.base.hash=${currentHash}`,
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

  private async bootstrapPipSite(podmanBin: string): Promise<void> {
    const env = this.getExecEnv();
    const script =
      'SITE=$(/opt/venv/bin/python3 -c "import sysconfig;print(sysconfig.get_path(\'purelib\'))") && ' +
      'echo /opt/pip-site > "$SITE/pip-site.pth"';
    try {
      await this.execAsync(podmanBin, ['exec', CONTAINER_NAME, 'sh', '-c', script], env);
      log.debug('[ContainerService] pip-site .pth file created');
    } catch (err) {
      log.warn('[ContainerService] pip-site bootstrap failed:', (err as Error).message);
    }
  }

  private invalidatePipSiteIfImageChanged(pipSiteDir: string): void {
    const settingsPath = getSettingsPath();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* */ }
    const tier = getImageTier();
    const currentVersion = (data.loadedImageVersion as Record<string, string> | undefined)?.[tier] ?? null;
    const cachedFor = (data as any).pipSiteImageVersion ?? null;
    if (cachedFor && cachedFor !== currentVersion) {
      log.info(`[ContainerService] Image changed (${cachedFor} → ${currentVersion}), clearing pip-site cache`);
      fs.rmSync(pipSiteDir, { recursive: true, force: true });
      fs.mkdirSync(pipSiteDir, { recursive: true });
    }
    if (currentVersion) {
      data.pipSiteImageVersion = currentVersion;
      fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
    }
  }

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

  private async runContainer(podmanBin: string, mountMap: Array<{ hostPath: string; containerPath: string }>, imageName?: string): Promise<void> {
    const env = this.getExecEnv();
    const agentDir = mountMap[0]?.hostPath;
    const volumeArgs = mountMap.flatMap(m => ['-v', `${toMountPath(m.hostPath)}:${m.containerPath}`]);

    // Find free host ports for the agent server (8080) and Jupyter kernel
    // gateway (8888) — both are eagerly started inside the same container.
    const agentHostPort = await findFreePort(23300, 23320);
    this.agentPort = agentHostPort;
    const kernelHostPort = await findFreePort(23330, 23350);
    this.kernelPort = kernelHostPort;

    const useImage = imageName || IMAGE_NAME;
    const useOverlay = process.env.OVERLAYFS_ENABLED === '1' && process.platform === 'darwin';
    this.overlayEnabled = useOverlay;

    const cacheDir = path.join(app.getPath('userData'), 'pkg-cache');
    const pipCache = path.join(cacheDir, 'pip');
    const pipSite = path.join(cacheDir, 'pip-site');
    const npmCache = path.join(cacheDir, 'npm');
    const npmSite = path.join(cacheDir, 'npm-site');
    const rLibs = path.join(cacheDir, 'r');
    fs.mkdirSync(pipCache, { recursive: true });
    fs.mkdirSync(pipSite, { recursive: true });
    fs.mkdirSync(npmCache, { recursive: true });
    fs.mkdirSync(npmSite, { recursive: true });
    fs.mkdirSync(rLibs, { recursive: true });
    this.invalidatePipSiteIfImageChanged(pipSite);
    const cacheVolumes = [
      '-v', `${toMountPath(pipCache)}:/root/.cache/pip`,
      '-v', `${toMountPath(pipSite)}:/opt/pip-site`,
      '-v', `${toMountPath(npmCache)}:/root/.npm`,
      '-v', `${toMountPath(npmSite)}:/opt/npm-site`,
      '-e', 'NODE_PATH=/opt/npm-site/lib/node_modules',
      '-v', `${toMountPath(rLibs)}:/opt/r-user-library`,
      '-e', 'R_LIBS_USER=/opt/r-user-library',
    ];

    // In overlay mode, only the agent-controlled dir (first entry) is overlaid
    // so container writes don't persist to the host. User directories are mounted
    // directly (read-write, no overlay) because user file changes should persist
    // immediately.
    const overlayVolumeArgs = mountMap.map((m, i) => {
      const containerPath = i === 0 ? '/data-host' : m.containerPath;
      return ['-v', `${toMountPath(m.hostPath)}:${containerPath}`];
    }).flat();

    const args = useOverlay ? [
      'run', '-d',
      '--replace',
      '--privileged',
      '--memory=2g',
      '--name', CONTAINER_NAME,
      ...overlayVolumeArgs,
      '-p', `${agentHostPort}:8080`,
      ...cacheVolumes,
      useImage,
      'sh', '-c',
      `mount -t tmpfs tmpfs /tmp -o size=${TMPFS_SIZE_GB}G && ` +
      'mkdir -p /tmp/overlay-upper /tmp/overlay-work && ' +
      'mount -t overlay overlay -o lowerdir=/data-host,upperdir=/tmp/overlay-upper,workdir=/tmp/overlay-work /data && ' +
      '(command -v rsync >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq rsync >/dev/null 2>&1)) && ' +
      'sleep infinity',
    ] : [
      'run', '-d',
      '--replace',
      '--memory=2g',
      '--name', CONTAINER_NAME,
      ...volumeArgs,
      '-p', `${agentHostPort}:8080`,
      '-p', `${kernelHostPort}:8888`,
      ...cacheVolumes,
      useImage,
      'sleep', 'infinity',
    ];

    log.debug(`[ContainerService] Running: podman ${args.join(' ')}`);

    // No timeout: when the base image is absent, `podman run` implicitly pulls
    // it, which can take 5+ minutes on slow connections.
    const containerId = await new Promise<string>((resolve, reject) => {
      const proc = spawn(podmanBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdoutBuf = '';
      const stderrLines: string[] = [];

      proc.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString();
      });
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          log.debug(`[ContainerService] [run] ${trimmed}`);
          stderrLines.push(trimmed);
          if (stderrLines.length > 20) stderrLines.shift();
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdoutBuf.trim().substring(0, 12));
        } else {
          const tail = stderrLines.slice(-5).join('\n');
          reject(new Error(`podman run exited with code ${code}${tail ? ': ' + tail : ''}`));
        }
      });
      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn podman run: ${err.message}`));
      });
    });
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
    this.currentAgentDir = agentDir;
    this.currentMountMap = mountMap;
    // Fresh container → fresh restart budget.
    this.kernelGatewayRestartAttempts = 0;
    this.agentServerConsecutiveFailures = 0;
    this.agentServerRestartAttempts = 0;
    this.lastKernelGatewayError = null;

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
    this.injectDepTracking(podmanBin, env);

    // Eagerly start the kernel gateway so mini-apps don't pay a cold-start
    // spinner on first open. Cost is ~1.4s + ~88 MB RSS — paid during the
    // container startup the user is already waiting through. Don't block the
    // overall start path on it: if it fails, the health watch will retry
    // (up to the cap) and the error is recorded on lastKernelGatewayError
    // so the renderer can surface it via gatewayStatus.
    this.startKernelGateway().catch((err) => {
      log.error('[ContainerService] Eager kernel start failed:', (err as Error).message);
    });

    this.startHealthWatch(podmanBin);
    this.startPeriodicSync();
  }

  // ─── OverlayFS Sync ──────────────────────────────────────────

  isOverlayEnabled(): boolean {
    return this.overlayEnabled;
  }

  async syncOverlay(): Promise<{ durationMs: number }> {
    if (this.activeSyncPromise) {
      return this.activeSyncPromise;
    }
    this.activeSyncPromise = this.doSyncOverlay();
    try {
      return await this.activeSyncPromise;
    } finally {
      this.activeSyncPromise = null;
    }
  }

  private async doSyncOverlay(): Promise<{ durationMs: number }> {
    if (!this.overlayEnabled || !this.isRunning()) {
      throw new Error('Overlay sync not available — overlay not enabled or container not running');
    }
    const start = Date.now();
    const { exitCode, stderr } = await this.exec([
      'rsync', '-a', '--delete',
      '--exclude', '.academia/claude',
      '--exclude', '.academia/agent-server.js',
      '--exclude', '.academia/agent.json',
      '--exclude', 'node_modules/.cache',
      '--exclude', '.applications/_environment',
      '/data/', '/data-host/',
    ]);
    if (exitCode !== 0) {
      log.warn(`[ContainerService] rsync exited with code ${exitCode}: ${stderr.slice(0, 200)}`);
    }
    const durationMs = Date.now() - start;
    log.info(`[ContainerService] Overlay synced in ${durationMs}ms`);
    return { durationMs };
  }

  startPeriodicSync(): void {
    this.stopPeriodicSync();
    if (!this.overlayEnabled) return;
    this.overlaySyncInterval = setInterval(() => {
      if (!this.isRunning()) return;
      this.syncOverlay().catch(err =>
        log.warn(`[ContainerService] Periodic overlay sync failed: ${(err as Error).message}`),
      );
    }, 30_000);
  }

  stopPeriodicSync(): void {
    if (this.overlaySyncInterval) {
      clearInterval(this.overlaySyncInterval);
      this.overlaySyncInterval = null;
    }
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

  // ─── Base Image Dependency Tracking ─────────────────────────

  private injectDepTracking(podmanBin: string, env: NodeJS.ProcessEnv): void {
    const pythonScript = [
      'import sys as _sys, json as _json, os as _os',
      '_DEP_LOG = "/tmp/dep-usage.jsonl"',
      '_BASE_PY = {',
      '  "defusedxml":"defusedxml","lxml":"lxml","pypdf":"pypdf",',
      '  "pdfplumber":"pdfplumber","pdf2image":"pdf2image","PIL":"Pillow",',
      '  "openpyxl":"openpyxl","markitdown":"markitdown",',
      '  "requests":"requests","pandas":"pandas","matplotlib":"matplotlib",',
      '  "chembl_webresource_client":"chembl_webresource_client",',
      '  "pubchempy":"pubchempy","GEOparse":"GEOparse",',
      '  "rcsbsearchapi":"rcsb-api","Bio":"biopython","flowkit":"flowkit",',
      '}',
      '_BASE_BINS = {',
      '  "pandoc":"pandoc","libreoffice":"libreoffice","soffice":"libreoffice",',
      '  "pdftotext":"poppler-utils","pdftoppm":"poppler-utils",',
      '  "pdfinfo":"poppler-utils","pdftocairo":"poppler-utils",',
      '  "pdflatex":"texlive","xelatex":"texlive","lualatex":"texlive",',
      '}',
      '_lpy = set()',
      '_lbn = set()',
      'def _dlog(e):',
      '  try:',
      '    with open(_DEP_LOG,"a") as f: f.write(_json.dumps(e)+"\\n")',
      '  except Exception: pass',
      'class _T:',
      '  def find_module(self,fullname,path=None):',
      '    top=fullname.split(".")[0]',
      '    if top in _BASE_PY and top not in _lpy:',
      '      _lpy.add(top)',
      '      from datetime import datetime',
      '      _dlog({"type":"python","import":top,"package":_BASE_PY[top],"time":datetime.utcnow().isoformat()+"Z"})',
      '    return None',
      '_sys.meta_path.insert(0,_T())',
      'try:',
      '  import subprocess as _sp',
      '  _oi=_sp.Popen.__init__',
      '  def _pi(self,args,*a,**kw):',
      '    try:',
      '      if args:',
      '        c=args if isinstance(args,str) else args[0]',
      '        b=_os.path.basename(str(c).split()[0] if isinstance(args,str) else str(c))',
      '        if b in _BASE_BINS and b not in _lbn:',
      '          _lbn.add(b)',
      '          from datetime import datetime',
      '          _dlog({"type":"system","binary":b,"package":_BASE_BINS[b],"time":datetime.utcnow().isoformat()+"Z"})',
      '    except Exception: pass',
      '    return _oi(self,args,*a,**kw)',
      '  _sp.Popen.__init__=_pi',
      'except Exception: pass',
    ].join('\n');

    const rScript = [
      'local({',
      '  base_pkgs <- c(',
      '    "DESeq2","SummarizedExperiment","apeglm","AnnotationDbi",',
      '    "org.Hs.eg.db","org.Mm.eg.db","BiocParallel","fgsea",',
      '    "IRkernel","argparse","data.table","dplyr","tibble",',
      '    "stringr","ggplot2","jsonlite","tidyr","patchwork",',
      '    "readr","purrr","ggtext","ggrepel","igraph","ggraph","ggnewscale"',
      '  )',
      '  base_bins <- c(',
      '    pandoc="pandoc",libreoffice="libreoffice",soffice="libreoffice",',
      '    pdftotext="poppler-utils",pdftoppm="poppler-utils",',
      '    pdfinfo="poppler-utils",pdflatex="texlive",',
      '    xelatex="texlive",lualatex="texlive"',
      '  )',
      '  lf <- "/tmp/dep-usage.jsonl"',
      '  logged <- new.env(parent=emptyenv())',
      '  logged_b <- new.env(parent=emptyenv())',
      '  dlog <- function(type,pkg,bf=NULL,bv=NULL) {',
      '    tryCatch({',
      '      ts <- format(Sys.time(),"%Y-%m-%dT%H:%M:%OSZ",tz="UTC")',
      '      if(!is.null(bf)) {',
      '        line <- sprintf(\'{"type":"%s","%s":"%s","package":"%s","time":"%s"}\',type,bf,bv,pkg,ts)',
      '      } else {',
      '        line <- sprintf(\'{"type":"%s","package":"%s","time":"%s"}\',type,pkg,ts)',
      '      }',
      '      cat(line,"\\n",file=lf,append=TRUE,sep="")',
      '    },error=function(e){})',
      '  }',
      '  for(pkg in base_pkgs) {',
      '    local({',
      '      p <- pkg',
      '      setHook(packageEvent(p,"onLoad"),function(...) {',
      '        if(!exists(p,envir=logged)) {',
      '          assign(p,TRUE,envir=logged)',
      '          dlog("R",p)',
      '        }',
      '      })',
      '    })',
      '  }',
      '  tryCatch({',
      '    orig_sys <- base::system',
      '    orig_sys2 <- base::system2',
      '    assignInNamespace("system",function(command,...) {',
      '      tryCatch({',
      '        b <- basename(trimws(strsplit(as.character(command),"\\\\s+")[[1]][1]))',
      '        if(b %in% names(base_bins) && !exists(b,envir=logged_b)) {',
      '          assign(b,TRUE,envir=logged_b)',
      '          dlog("system",base_bins[[b]],"binary",b)',
      '        }',
      '      },error=function(e){})',
      '      orig_sys(command,...)',
      '    },ns="base")',
      '    assignInNamespace("system2",function(command,...) {',
      '      tryCatch({',
      '        b <- basename(as.character(command)[1])',
      '        if(b %in% names(base_bins) && !exists(b,envir=logged_b)) {',
      '          assign(b,TRUE,envir=logged_b)',
      '          dlog("system",base_bins[[b]],"binary",b)',
      '        }',
      '      },error=function(e){})',
      '      orig_sys2(command,...)',
      '    },ns="base")',
      '  },error=function(e){})',
      '})',
    ].join('\n');

    // Shell script that creates wrapper scripts in /usr/local/bin/ (earlier on
    // PATH than /usr/bin/) for each tracked system binary. Each wrapper logs
    // first use to the JSONL file, then exec's the real binary. This catches
    // direct bash invocations (e.g. agent running `soffice --headless ...`).
    // Uses a quoted heredoc (<< 'WEOF') so $vars stay literal in the template,
    // then sed replaces __PLACEHOLDERS__ with actual values.
    const wrapperScript = [
      '#!/bin/sh',
      'BINS="pandoc:pandoc soffice:libreoffice libreoffice:libreoffice pdftotext:poppler-utils pdftoppm:poppler-utils pdfinfo:poppler-utils pdftocairo:poppler-utils pdflatex:texlive xelatex:texlive lualatex:texlive"',
      'for entry in $BINS; do',
      '  name="${entry%%:*}"',
      '  pkg="${entry#*:}"',
      '  real=$(command -v "$name" 2>/dev/null)',
      '  if [ -n "$real" ] && [ ! -f "/usr/local/bin/$name" ]; then',
      '    cat > "/usr/local/bin/$name" << \'WEOF\'',
      '#!/bin/sh',
      'm="/tmp/.dep-used-__NAME__"',
      'if [ ! -f "$m" ]; then',
      '  touch "$m"',
      '  printf \'{"type":"system","binary":"__NAME__","package":"__PKG__","time":"%s"}\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/dep-usage.jsonl',
      'fi',
      'exec "__REAL__" "$@"',
      'WEOF',
      '    sed -i "s|__NAME__|$name|g;s|__PKG__|$pkg|g;s|__REAL__|$real|g" "/usr/local/bin/$name"',
      '    chmod +x "/usr/local/bin/$name"',
      '  fi',
      'done',
    ].join('\n');

    const pyB64 = Buffer.from(pythonScript).toString('base64');
    const rB64 = Buffer.from(rScript).toString('base64');
    const wrapperB64 = Buffer.from(wrapperScript).toString('base64');

    const setupCmd = [
      'touch /tmp/dep-usage.jsonl',
      'SITE=$(/opt/venv/bin/python3 -c "import sysconfig;print(sysconfig.get_path(\'purelib\'))")',
      `echo '${pyB64}' | base64 -d > "$SITE/sitecustomize.py"`,
      `echo '${rB64}' | base64 -d > /root/.Rprofile`,
      `echo '${wrapperB64}' | base64 -d | sh`,
    ].join(' && ');

    // Inject hooks, then start tailing the usage log
    const proc = spawn(podmanBin, ['exec', CONTAINER_NAME, 'sh', '-c', setupCmd], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        log.warn(`[DepTracking] Hook injection exited with code ${code}`);
        return;
      }
      log.info('[DepTracking] Tracking hooks injected for base image dependencies');
      this.startDepTrackingTail(podmanBin, env);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      log.debug(`[DepTracking] inject stderr: ${data.toString().trim()}`);
    });
  }

  private startDepTrackingTail(podmanBin: string, env: NodeJS.ProcessEnv): void {
    const proc = spawn(podmanBin, [
      'exec', CONTAINER_NAME, 'tail', '-n', '+1', '-f', '/tmp/dep-usage.jsonl',
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.depTrackingProc = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry.type === 'system') {
            log.info(`[DepTracking] ${entry.type}: ${entry.binary} (package: ${entry.package})`);
          } else {
            log.info(`[DepTracking] ${entry.type}: ${entry.import || entry.package} (package: ${entry.package})`);
          }
        } catch {
          log.debug(`[DepTracking] ${trimmed}`);
        }
      }
    });

    proc.on('exit', () => {
      if (this.depTrackingProc === proc) this.depTrackingProc = null;
    });
  }

  private stopDepTracking(): void {
    if (this.depTrackingProc) {
      try {
        if (this.depTrackingProc.exitCode === null && this.depTrackingProc.signalCode === null) {
          this.depTrackingProc.kill('SIGTERM');
        }
      } catch { /* ignore */ }
      this.depTrackingProc = null;
    }
  }

  private collectDepUsage(podmanBin: string): void {
    if (!this.containerStarted) return;
    try {
      const result = execFileSync(podmanBin, [
        'exec', CONTAINER_NAME, 'cat', '/tmp/dep-usage.jsonl',
      ], { env: this.getExecEnv(), timeout: 5000, encoding: 'utf-8' });

      const lines = result.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        log.info('[DepTracking] No base image dependencies were used this session');
        return;
      }

      const used: Record<string, string[]> = { python: [], R: [], system: [] };
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          const label = e.type === 'system' ? `${e.binary} (${e.package})` : e.package;
          if (!used[e.type]?.includes(label)) {
            (used[e.type] ??= []).push(label);
          }
        } catch { /* skip */ }
      }

      log.info('[DepTracking] ── Session summary ──');
      if (used.python.length) log.info(`[DepTracking]   Python used: ${used.python.join(', ')}`);
      if (used.R.length) log.info(`[DepTracking]   R used: ${used.R.join(', ')}`);
      if (used.system.length) log.info(`[DepTracking]   System used: ${used.system.join(', ')}`);

      const allPyPkgs = ['defusedxml','lxml','pypdf','pdfplumber','pdf2image','Pillow','openpyxl','markitdown','requests','pandas','matplotlib','chembl_webresource_client','pubchempy','GEOparse','rcsb-api','biopython','flowkit'];
      const allRPkgs = ['DESeq2','SummarizedExperiment','apeglm','AnnotationDbi','org.Hs.eg.db','org.Mm.eg.db','BiocParallel','fgsea','IRkernel','argparse','data.table','dplyr','tibble','stringr','ggplot2','jsonlite','tidyr','patchwork','readr','purrr','ggtext','ggrepel','igraph','ggraph','ggnewscale'];
      const unusedPy = allPyPkgs.filter(p => !used.python.includes(p));
      const unusedR = allRPkgs.filter(p => !used.R.includes(p));
      if (unusedPy.length) log.info(`[DepTracking]   Python unused: ${unusedPy.join(', ')}`);
      if (unusedR.length) log.info(`[DepTracking]   R unused: ${unusedR.join(', ')}`);
    } catch (err) {
      log.debug(`[DepTracking] Could not collect usage: ${(err as Error).message}`);
    }
  }

  // ─── Container Health Watch ──────────────────────────────────

  private startHealthWatch(podmanBin: string): void {
    this.stopHealthWatch();
    this.healthCheckInterval = setInterval(async () => {
      if (!this.containerStarted || this.isStarting || !this.currentAgentDir) return;

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
          await this.runContainer(podmanBin, this.currentMountMap);
          log.info('[ContainerService] Container restarted successfully');
        } catch (err) {
          log.error('[ContainerService] Auto-restart failed:', (err as Error).message);
          captureError(err, { subsystem: 'container', extra: { phase: 'auto_restart' } });
        } finally {
          this.isStarting = false;
        }
        return;
      }

      // Container is alive — check the long-running in-container processes
      // independently. Both have a restart cap so a genuinely broken
      // service (missing binary, port conflict, OOM loop) doesn't spin
      // forever and leak podman-exec wrappers on each retry.
      await this.watchKernelGateway();
      await this.watchAgentServer();
    }, 10_000);
  }

  private static readonly KERNEL_GATEWAY_RESTART_CAP = 5;
  private static readonly AGENT_SERVER_FAILURE_THRESHOLD = 2; // ~20s of unresponsive /health before action
  private static readonly AGENT_SERVER_RESTART_CAP = 3;

  /**
   * Probe the kernel gateway and restart it if it's down, up to the
   * restart cap. The cap exists because a persistently-broken gateway
   * (missing dep, port collision) would otherwise burn a podman-exec
   * wrapper every 10s indefinitely. When the cap is hit, the renderer's
   * next user-initiated startGateway() call still gets a fresh attempt —
   * the cap only governs autonomous retries.
   */
  private async watchKernelGateway(): Promise<void> {
    if (!this.kernelPort || this.kernelStartPromise) return;
    const healthy = await this.isKernelGatewayHealthy(2000);
    if (healthy) {
      if (this.kernelGatewayRestartAttempts > 0) {
        log.info('[ContainerService] Kernel gateway recovered');
        this.kernelGatewayRestartAttempts = 0;
        this.lastKernelGatewayError = null;
      }
      return;
    }

    const cap = CobuildingContainerService.KERNEL_GATEWAY_RESTART_CAP;
    if (this.kernelGatewayRestartAttempts >= cap) {
      // Already gave up — log once on first crossing only to avoid spam.
      return;
    }
    this.kernelGatewayRestartAttempts++;
    log.warn(
      `[ContainerService] Kernel gateway not responding (auto-restart ${this.kernelGatewayRestartAttempts}/${cap})`,
    );
    try {
      await this.startKernelGateway();
    } catch (err) {
      log.error('[ContainerService] Kernel restart failed:', (err as Error).message);
      if (this.kernelGatewayRestartAttempts >= cap) {
        log.error(
          `[ContainerService] Kernel gateway gave up after ${cap} auto-restart attempts. ` +
          'Open a mini-app to retry manually.',
        );
      }
    }
  }

  /**
   * Probe the agent server's /health endpoint and restart it if it's been
   * unresponsive for long enough. Conservative thresholds to avoid killing
   * a live session whose /health is briefly delayed:
   *   - Requires AGENT_SERVER_FAILURE_THRESHOLD consecutive failures
   *     (~20s) before attempting a restart.
   *   - Caps total restarts at AGENT_SERVER_RESTART_CAP so a genuinely
   *     broken agent doesn't pkill itself in a loop.
   *   - Only fires if startAgentServer has been called at least once for
   *     the current container (cached config + workspacePath are non-null);
   *     stopAgentServer clears the cache, so an intentional teardown is
   *     never re-revived.
   */
  private async watchAgentServer(): Promise<void> {
    if (!this.agentPort) return;
    // Capture cached params at probe time so an intervening stopAgentServer
    // (which nulls the cache) doesn't strand us mid-flight calling
    // startAgentServer with stale half-state.
    const cachedConfig = this.lastAgentServerConfig;
    const cachedWorkspacePath = this.lastAgentServerWorkspacePath;
    if (!cachedConfig || !cachedWorkspacePath) return;

    const healthy = await this.isAgentServerHealthy(2000);
    if (healthy) {
      if (this.agentServerRestartAttempts > 0 && this.agentServerConsecutiveFailures === 0) {
        log.info('[ContainerService] Agent server recovered');
        this.agentServerRestartAttempts = 0;
      }
      this.agentServerConsecutiveFailures = 0;
      return;
    }

    this.agentServerConsecutiveFailures++;
    const failureThreshold = CobuildingContainerService.AGENT_SERVER_FAILURE_THRESHOLD;
    const restartCap = CobuildingContainerService.AGENT_SERVER_RESTART_CAP;

    if (this.agentServerConsecutiveFailures < failureThreshold) return;
    if (this.agentServerRestartAttempts >= restartCap) return;

    // The cache could have been cleared while we were probing — if so,
    // bail and let the next tick handle it (or stay quiet if the user
    // tore the agent down intentionally).
    if (this.lastAgentServerConfig !== cachedConfig) return;

    this.agentServerRestartAttempts++;
    this.agentServerConsecutiveFailures = 0;
    log.warn(
      `[ContainerService] Agent server unresponsive for ~${failureThreshold * 10}s ` +
      `(auto-restart ${this.agentServerRestartAttempts}/${restartCap})`,
    );
    try {
      await this.startAgentServer(cachedConfig, cachedWorkspacePath);
    } catch (err) {
      log.error('[ContainerService] Agent restart failed:', (err as Error).message);
      if (this.agentServerRestartAttempts >= restartCap) {
        log.error(
          `[ContainerService] Agent server gave up after ${restartCap} auto-restart attempts. ` +
          'The chat will need to be re-initialized from the renderer.',
        );
      }
    }
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

  async pruneImages(podmanBinOverride?: string): Promise<void> {
    const podmanBin = podmanBinOverride ?? this.getPodmanBin();
    try {
      await this.logDiskUsage('pre-prune');
      const pruneArgs = ['image', 'prune', '-a', '-f'];
      log.info('[ContainerService] Pruning all unused images...');
      const { stdout } = await execFileAsync(podmanBin, pruneArgs, { env: this.getExecEnv(), timeout: 60_000 });
      const pruned = stdout.trim().split('\n').filter(Boolean);
      log.info(`[ContainerService] Pruned ${pruned.length} image(s)`);
      try {
        log.info('[ContainerService] Running fstrim to reclaim VM disk space...');
        await execFileAsync(podmanBin, ['machine', 'ssh', '--', 'sudo', 'fstrim', '-v', '/'], { env: this.getExecEnv(), timeout: 120_000 });
        log.info('[ContainerService] fstrim complete');
      } catch (err) {
        log.warn(`[ContainerService] fstrim failed: ${(err as Error).message}`);
      }
      await this.logDiskUsage('post-prune');
    } catch (err) {
      log.warn(`[ContainerService] Image prune failed: ${(err as Error).message}`);
    }
  }

  private async logDiskUsage(label: string): Promise<void> {
    const tag = `[ContainerService] [DiskUsage:${label}]`;
    try {
      const parts: string[] = [];

      // VM disk file (macOS only — sparse .raw file)
      if (process.platform === 'darwin') {
        const vmDir = path.join(
          app.getPath('userData'),
          'cobuilding-podman-data', 'data', 'containers', 'podman', 'machine', 'applehv',
        );
        try {
          const entries = await fs.promises.readdir(vmDir);
          for (const entry of entries) {
            if (entry.endsWith('.raw')) {
              const stat = await fs.promises.stat(path.join(vmDir, entry));
              const actualGB = (stat.blocks * 512 / 1e9).toFixed(1);
              parts.push(`VM disk: ${actualGB} GB`);
            }
          }
        } catch { /* VM dir may not exist */ }
      }

      // podman system df
      const podmanBin = this.getPodmanBinIfExists();
      if (podmanBin) {
        try {
          const { stdout } = await execFileAsync(podmanBin, [
            'system', 'df', '--format',
            '{{.Type}}\t{{.Total}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}',
          ], { env: this.getExecEnv(), timeout: 15_000 });
          for (const line of stdout.trim().split('\n').filter(Boolean)) {
            const [type, total, active, size, reclaimable] = line.trim().split('\t');
            if (type === 'Images') {
              parts.push(`Images: ${total} total, ${active} active, ${size} size, ${reclaimable} reclaimable`);
            }
          }
        } catch { /* podman not reachable */ }
      }

      // Package cache
      try {
        const cacheDir = path.join(app.getPath('userData'), 'pkg-cache');
        const sizes: string[] = [];
        for (const sub of ['pip', 'npm', 'r']) {
          try {
            const { stdout } = await execFileAsync('du', ['-sk', path.join(cacheDir, sub)], { timeout: 10_000 });
            const mb = (parseInt(stdout.split('\t')[0], 10) / 1024).toFixed(0);
            sizes.push(`${sub}=${mb} MB`);
          } catch { sizes.push(`${sub}=0 MB`); }
        }
        parts.push(`pkg-cache: ${sizes.join(', ')}`);
      } catch { /* no cache dir */ }

      if (parts.length > 0) {
        log.info(`${tag} ${parts.join(' | ')}`);
      }
    } catch (err) {
      log.debug(`${tag} failed: ${(err as Error).message}`);
    }
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
