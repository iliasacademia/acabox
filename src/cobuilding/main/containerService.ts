import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
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

const execFileAsync = promisify(execFile);

const IMAGE_NAME = 'cobuilding-container';
const CONTAINER_NAME = 'cobuilding-container';

type BinaryMode = 'system' | 'bundled';
type ProgressCallback = (stage: string, message: string) => void;

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

class CobuildingContainerService {
  private containerStarted = false;
  private isStarting = false;

  // ─── Public API ─────────────────────────────────────────────────

  async start(workspacePath: string, onProgress?: ProgressCallback): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    if (this.isStarting) {
      return;
    }
    this.isStarting = true;

    try {
      // Ensure podman is available
      if (this.useBundled()) {
        await ensureBinariesDownloaded(onProgress);
      }
      const podmanBin = this.getPodmanBin();

      // Ensure podman machine is ready (macOS requirement)
      if (process.platform === 'darwin') {
        await this.ensureMachineRunning(podmanBin, onProgress);
      }

      // Remove any stale container from a previous crash
      await this.removeStaleContainer(podmanBin);

      // Build the container image if needed
      onProgress?.('build', 'Building container image...');
      await this.ensureImageBuilt(podmanBin, onProgress);

      // Start the container in detached mode
      onProgress?.('run', 'Starting container...');
      await this.runContainer(podmanBin, workspacePath);

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
    log.debug('[ContainerService] Stopping container...');
    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();

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

  async exec(command: string[]): Promise<{ stdout: string; stderr: string }> {
    if (!this.isRunning()) {
      throw new Error('Container is not running');
    }
    const podmanBin = this.getPodmanBin();
    const args = ['exec', CONTAINER_NAME, ...command];
    return this.execAsync(podmanBin, args, this.getExecEnv());
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

  getBundledBinaryStatus(): { downloaded: boolean; binDir: string } {
    const binDir = getBundledPodmanBinDir();
    const podmanBin = path.join(binDir, 'podman');
    const gvproxyBin = path.join(binDir, 'gvproxy');
    const vfkitBin = path.join(binDir, 'vfkit');
    return {
      downloaded: fs.existsSync(podmanBin) && fs.existsSync(gvproxyBin) && fs.existsSync(vfkitBin),
      binDir,
    };
  }

  async downloadBundledBinaries(onProgress?: ProgressCallback): Promise<void> {
    await ensureBinariesDownloaded(onProgress);
  }

  getContainerName(): string {
    return CONTAINER_NAME;
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

    const initialized = await this.isMachineInitialized(podmanBin, env);
    if (!initialized) {
      onProgress?.('init', 'Initializing Podman VM (first-time setup)...');
      log.debug('[ContainerService] Machine not initialized, running podman machine init...');
      await this.spawnAndWait(podmanBin, ['machine', 'init'], env, 'machine init');
    }

    const running = await this.isMachineRunning(podmanBin, env);
    if (!running) {
      onProgress?.('start-machine', 'Starting Podman VM...');
      log.debug('[ContainerService] Machine not running, starting...');
      await this.spawnAndWait(podmanBin, ['machine', 'start'], env, 'machine start');
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

    const scriptsDir = path.join(contextDir, 'skills', 'differential-expression', 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const files = fs.readdirSync(scriptsDir).sort();
      for (const file of files) {
        const filePath = path.join(scriptsDir, file);
        if (fs.statSync(filePath).isFile()) {
          hash.update(file);
          hash.update(fs.readFileSync(filePath));
        }
      }
    }

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

  private async ensureImageBuilt(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const currentHash = this.getDockerfileHash();
    const imageHash = await this.getImageHash(podmanBin);

    if (imageHash === currentHash) {
      log.debug(`[ContainerService] Image up to date (hash: ${currentHash})`);
      return;
    }

    if (imageHash) {
      log.debug(`[ContainerService] Dockerfile changed (${imageHash} -> ${currentHash}), rebuilding...`);
      onProgress?.('build', 'Dockerfile changed, rebuilding image...');
    } else {
      log.debug('[ContainerService] Building container image...');
      onProgress?.('build', 'Building container image (first-time setup)...');
    }

    const contextDir = this.getDockerfileDir();
    const dockerfilePath = path.join(contextDir, 'Dockerfile');

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(podmanBin, [
        'build',
        '--label', `dockerfile.hash=${currentHash}`,
        '-t', IMAGE_NAME,
        '-f', dockerfilePath,
        contextDir,
      ], {
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

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) log.debug(`[ContainerService] [build stderr] ${line}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          log.debug('[ContainerService] Image built successfully');
          resolve();
        } else {
          reject(new Error(`podman build exited with code ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to build container image: ${error.message}`));
      });
    });
  }

  // ─── Container Lifecycle ──────────────────────────────────────

  private async removeStaleContainer(podmanBin: string): Promise<void> {
    try {
      await this.execAsync(podmanBin, ['rm', '-f', CONTAINER_NAME], this.getExecEnv());
      log.debug('[ContainerService] Removed stale container');
    } catch {
      // Container didn't exist — that's fine
    }
  }

  private async runContainer(podmanBin: string, workspacePath: string): Promise<void> {
    const args = [
      'run', '-d',
      '--name', CONTAINER_NAME,
      '-v', `${workspacePath}:/data`,
      IMAGE_NAME,
      'sleep', 'infinity',
    ];

    log.debug(`[ContainerService] Running: podman ${args.join(' ')}`);

    const { stdout } = await this.execAsync(podmanBin, args, this.getExecEnv());
    const containerId = stdout.trim().substring(0, 12);
    log.debug(`[ContainerService] Container started with ID: ${containerId}`);
    this.containerStarted = true;
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

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) log.debug(`[ContainerService] [${label}] ${line}`);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) log.debug(`[ContainerService] [${label} stderr] ${line}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          log.debug(`[ContainerService] ${label} completed successfully`);
          resolve();
        } else {
          reject(new Error(`podman ${label} exited with code ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to run podman ${label}: ${error.message}`));
      });
    });
  }
}

export const containerService = new CobuildingContainerService();
