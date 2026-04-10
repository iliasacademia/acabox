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
import { commandLogger, parseAppDirFromArgs, type CommandSource } from './commandLogger';

const execFileAsync = promisify(execFile);

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

      // Pull base image and build skills layer if needed
      onProgress?.('build', 'Preparing container image...');
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
    this.stopLogTail();
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
    this.currentWorkspacePath = null;
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

  async ensureSetup(onProgress?: ProgressCallback): Promise<void> {
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

      // Step 3: Pull base image and build skills layer if not already built (or outdated)
      const imageBuilt = await this.isImageBuilt();
      if (!imageBuilt) {
        onProgress?.('build-image', 'Preparing container image...');
        await this.ensureImageBuilt(podmanBin, onProgress);
        onProgress?.('build-image-done', 'Image ready');
      } else {
        // Check if it needs a rebuild (hash mismatch)
        const currentHash = this.getDockerfileHash();
        const imageHash = await this.getImageHash(podmanBin);
        if (imageHash !== currentHash) {
          onProgress?.('build-image', 'Skills changed, rebuilding...');
          await this.ensureImageBuilt(podmanBin, onProgress);
          onProgress?.('build-image-done', 'Image rebuilt');
        }
      }
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
    // Check if the base image already exists locally
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{.Id}}', GHCR_BASE_IMAGE,
      ], this.getExecEnv());
      if (stdout.trim().length > 0) {
        log.debug('[ContainerService] Base image already present locally');
        return;
      }
    } catch {
      // Image not present — pull it
    }

    log.debug(`[ContainerService] Pulling base image: ${GHCR_BASE_IMAGE}`);
    onProgress?.('pull', 'Pulling base image from registry...', 0);

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

      // Manifest list — find the amd64 entry and fetch its manifest
      if (parsed.manifests) {
        const amd64 = parsed.manifests.find(
          (m: { platform?: { architecture?: string; os?: string } }) =>
            m.platform?.architecture === 'amd64' && m.platform?.os === 'linux'
        );
        if (amd64?.digest) {
          const imageRef = GHCR_BASE_IMAGE.replace(/:([^@]+)$/, `@${amd64.digest}`);
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
      const proc = spawn(podmanBin, ['pull', '--platform', 'linux/amd64', image], {
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

  private async ensureImageBuilt(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const currentHash = this.getDockerfileHash();
    const imageHash = await this.getImageHash(podmanBin);

    if (imageHash === currentHash) {
      log.debug(`[ContainerService] Image up to date (hash: ${currentHash})`);
      return;
    }

    const imageSource = readImageSource();

    if (imageSource === 'registry') {
      // Pull the prebuilt base image from GHCR if not already present
      await this.ensureBaseImagePulled(podmanBin, onProgress);
    } else {
      // Build the base image locally from Dockerfile.base
      await this.buildBaseImageLocally(podmanBin, onProgress);
    }

    if (imageHash) {
      log.debug(`[ContainerService] Skills changed (${imageHash} -> ${currentHash}), rebuilding...`);
      onProgress?.('build', 'Skills changed, rebuilding image...');
    } else {
      log.debug('[ContainerService] Building container image (skills layer)...');
      onProgress?.('build', 'Building container image...');
    }

    const contextDir = this.getDockerfileDir();
    const dockerfilePath = path.join(contextDir, 'Dockerfile');
    const baseImage = imageSource === 'registry'
      ? GHCR_BASE_IMAGE
      : LOCAL_BASE_IMAGE;

    return this.spawnBuild(podmanBin, [
      'build',
      '--label', `dockerfile.hash=${currentHash}`,
      '--build-arg', `BASE_IMAGE=${baseImage}`,
      '-t', IMAGE_NAME,
      '-f', dockerfilePath,
      contextDir,
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

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) log.debug(`[ContainerService] [build stderr] ${line}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          log.debug('[ContainerService] Build completed successfully');
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

  private async runContainer(podmanBin: string, workspacePath: string): Promise<void> {
    const env = this.getExecEnv();
    const mountPath = toMountPath(workspacePath);
    const args = [
      'run', '-d',
      '--replace',
      '--name', CONTAINER_NAME,
      '-v', `${mountPath}:/data`,
      IMAGE_NAME,
      'sleep', 'infinity',
    ];

    log.debug(`[ContainerService] Running: podman ${args.join(' ')}`);

    const { stdout } = await this.execAsync(podmanBin, args, env);
    const containerId = stdout.trim().substring(0, 12);
    log.debug(`[ContainerService] Container started with ID: ${containerId}`);

    // Verify the mount is correct
    try {
      const { stdout: mountSource } = await this.execAsync(podmanBin, [
        'inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', CONTAINER_NAME,
      ], env);
      log.debug(`[ContainerService] Container /data mount source: ${mountSource.trim()}`);
    } catch (err) {
      log.warn(`[ContainerService] Could not verify mount: ${(err as Error).message}`);
    }

    this.containerStarted = true;
    this.currentWorkspacePath = workspacePath;
    this.startLogTail(podmanBin);
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
