import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import log from 'electron-log';

const execFileAsync = promisify(execFile);

const IMAGE_NAME = 'cobuilding-container';
const CONTAINER_NAME = 'cobuilding-container';

type ProgressCallback = (stage: string, message: string) => void;

class CobuildingContainerService {
  private containerStarted = false;
  private isStarting = false;

  async start(workspacePath: string, onProgress?: ProgressCallback): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    if (this.isStarting) {
      return;
    }
    this.isStarting = true;

    try {
      // Remove any stale container from a previous crash
      await this.removeStaleContainer();

      // Build the container image if needed
      onProgress?.('build', 'Building container image...');
      await this.ensureImageBuilt(onProgress);

      // Start the container in detached mode
      onProgress?.('run', 'Starting container...');
      await this.runContainer(workspacePath);

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

    try {
      execFileSync('docker', ['stop', '-t', '3', CONTAINER_NAME], { timeout: 10000 });
      log.debug('[ContainerService] Container stopped');
    } catch {
      log.debug('[ContainerService] Container was not running or already stopped');
    }

    try {
      execFileSync('docker', ['rm', '-f', CONTAINER_NAME], { timeout: 5000 });
      log.debug('[ContainerService] Container removed');
    } catch {
      // Already removed
    }

    this.containerStarted = false;
  }

  isRunning(): boolean {
    if (!this.containerStarted) return false;

    try {
      const result = execFileSync('docker', [
        'inspect', '--format', '{{.State.Running}}', CONTAINER_NAME,
      ], { timeout: 5000, encoding: 'utf-8' });
      return result.trim() === 'true';
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

  private async getImageHash(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'image', 'inspect', '--format', '{{index .Config.Labels "dockerfile.hash"}}', IMAGE_NAME,
      ]);
      const hash = stdout.trim();
      return hash && hash !== '<no value>' ? hash : null;
    } catch {
      return null;
    }
  }

  private async ensureImageBuilt(onProgress?: ProgressCallback): Promise<void> {
    const currentHash = this.getDockerfileHash();
    const imageHash = await this.getImageHash();

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
      const proc = spawn('docker', [
        'build', '--no-cache',
        '--label', `dockerfile.hash=${currentHash}`,
        '-t', IMAGE_NAME,
        '-f', dockerfilePath,
        contextDir,
      ], {
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
          reject(new Error(`docker build exited with code ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to build container image: ${error.message}`));
      });
    });
  }

  // ─── Container Lifecycle ──────────────────────────────────────

  private async removeStaleContainer(): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '-f', CONTAINER_NAME]);
      log.debug('[ContainerService] Removed stale container');
    } catch {
      // Container didn't exist — that's fine
    }
  }

  private async runContainer(workspacePath: string): Promise<void> {
    const args = [
      'run', '-d',
      '--name', CONTAINER_NAME,
      '-v', `${workspacePath}:/data`,
      IMAGE_NAME,
      'sleep', 'infinity',
    ];

    log.debug(`[ContainerService] Running: docker ${args.join(' ')}`);

    const { stdout } = await execFileAsync('docker', args);
    const containerId = stdout.trim().substring(0, 12);
    log.debug(`[ContainerService] Container started with ID: ${containerId}`);
    this.containerStarted = true;
  }
}

export const containerService = new CobuildingContainerService();
