import { ChildProcess, spawn, execFile, execFileSync } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { defaultLogger as logger } from './utils/logger';

const IMAGE_NAME = 'writing-agent-shell';
const CONTAINER_NAME = 'writing-agent-shell';
const TTYD_CONTAINER_PORT = 7681;
const PREVIEW_CONTAINER_PORT = 3000;
const HOST_PORT_START = 23200;
const HOST_PORT_RANGE = 20; // need pairs: ttyd + preview
const READY_POLL_INTERVAL_MS = 500;
const READY_POLL_MAX_RETRIES = 60; // 30 seconds max wait

// Podman binary versions and download URLs
const PODMAN_VERSION = '5.3.1';
const GVPROXY_VERSION = '0.8.0';
const VFKIT_VERSION = '0.6.0';

type ProgressCallback = (stage: string, message: string) => void;

class PodmanService {
  private containerProcess: ChildProcess | null = null;
  private shellPort: number | null = null;
  private previewPort: number | null = null;
  private isStarting = false;
  private logStream: fs.WriteStream | null = null;

  // ─── Public API ───────────────────────────────────────────────

  async start(onProgress?: ProgressCallback): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    if (this.isStarting) {
      return;
    }
    this.isStarting = true;
    this.openLogStream();

    try {
      // Download podman binaries if not present
      await this.ensureBinariesDownloaded(onProgress);

      const podmanBin = this.getPodmanBin();
      this.log(`Using podman at: ${podmanBin}`);

      // Ensure podman machine is ready (macOS requirement)
      if (process.platform === 'darwin') {
        const machineInitialized = await this.isMachineInitialized(podmanBin);
        if (!machineInitialized) {
          onProgress?.('init', 'Downloading Podman VM (~700MB, first-time setup)...');
          this.log('Machine not initialized, running podman machine init...');
          await this.initMachine(podmanBin, onProgress);
        }

        const machineRunning = await this.isMachineRunning(podmanBin);
        if (!machineRunning) {
          onProgress?.('start-machine', 'Starting Podman VM...');
          this.log('Machine not running, starting...');
          await this.startMachine(podmanBin, onProgress);
        }
      }

      // Ensure workspace directory exists
      this.ensureWorkspaceDir();

      // Remove any stale container from a previous crash
      await this.removeStaleContainer(podmanBin);

      // Build the container image if needed
      onProgress?.('build', 'Building container image...');
      await this.ensureImageBuilt(podmanBin, onProgress);

      // Find two free ports: one for ttyd, one for preview server
      const { ttydPort, previewPort } = await this.findFreePorts();
      this.log(`Using port ${ttydPort} for ttyd, ${previewPort} for preview server`);

      // Start the container
      onProgress?.('run', 'Starting terminal...');
      await this.runContainer(podmanBin, ttydPort, previewPort);

      // Wait for ttyd to be ready
      await this.waitForReady(ttydPort);

      this.shellPort = ttydPort;
      this.previewPort = previewPort;
      this.log(`Web shell available at http://127.0.0.1:${ttydPort}`);
      this.log(`Preview server available at http://127.0.0.1:${previewPort}`);
      onProgress?.('ready', `Terminal ready at http://127.0.0.1:${ttydPort}`);
    } catch (error) {
      this.log(`ERROR: ${(error as Error).message}`);
      this.log(`Stack: ${(error as Error).stack}`);
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  stop(): void {
    if (!this.containerProcess) {
      return;
    }

    this.log('Stopping container...');
    const podmanBin = this.getPodmanBin();

    // Synchronously stop the container so it completes before the app exits
    try {
      execFileSync(podmanBin, ['stop', '-t', '3', CONTAINER_NAME], {
        env: this.getPodmanEnv(),
        timeout: 5000,
      });
      this.log('Container stopped successfully');
    } catch (error) {
      this.log(`Warning during podman stop: ${(error as Error).message}`);
      // Fall back to killing the process directly
      if (this.containerProcess) {
        this.containerProcess.kill('SIGKILL');
        this.log('Killed container process directly');
      }
    }

    this.containerProcess = null;
    this.shellPort = null;
    this.previewPort = null;
    this.log('Cleanup complete');
    this.closeLogStream();
  }

  getShellUrl(): string | null {
    if (this.shellPort === null) return null;
    return `http://127.0.0.1:${this.shellPort}`;
  }

  getPreviewUrl(): string | null {
    if (this.previewPort === null) return null;
    return `http://127.0.0.1:${this.previewPort}`;
  }

  isRunning(): boolean {
    return this.containerProcess !== null && this.shellPort !== null;
  }

  // ─── Binary Resolution ────────────────────────────────────────

  private getPodmanBinDir(): string {
    // Always use userData — writable, persists, works in both dev and packaged
    return path.join(app.getPath('userData'), 'podman-bin');
  }

  private getPodmanBin(): string {
    const binDir = this.getPodmanBinDir();
    const bundledBin = path.join(binDir, 'podman');
    if (fs.existsSync(bundledBin)) {
      return bundledBin;
    }

    // Fallback: system podman
    const systemPaths = [
      '/opt/homebrew/bin/podman',
      '/usr/local/bin/podman',
      '/usr/bin/podman',
    ];
    for (const p of systemPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Last resort: hope it's in PATH
    return 'podman';
  }

  private async ensureBinariesDownloaded(onProgress?: ProgressCallback): Promise<void> {
    const binDir = this.getPodmanBinDir();
    const podmanBin = path.join(binDir, 'podman');
    const gvproxyBin = path.join(binDir, 'gvproxy');
    const vfkitBin = path.join(binDir, 'vfkit');

    // All three must exist
    if (fs.existsSync(podmanBin) && fs.existsSync(gvproxyBin) && fs.existsSync(vfkitBin)) {
      this.log('Podman binaries already present');
      return;
    }

    fs.mkdirSync(binDir, { recursive: true });
    onProgress?.('download', 'Downloading Podman binaries...');
    this.log('Downloading podman binaries...');

    // Download podman from .pkg and extract
    if (!fs.existsSync(podmanBin)) {
      onProgress?.('download', 'Downloading podman...');
      const pkgUrl = `https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-installer-macos-universal.pkg`;
      const pkgPath = path.join(binDir, 'podman.pkg');
      await this.downloadFile(pkgUrl, pkgPath);

      // Extract podman binary from .pkg using pkgutil
      this.log('Extracting podman from .pkg...');
      const tempDir = path.join(binDir, '_extract_tmp');
      fs.mkdirSync(tempDir, { recursive: true });
      try {
        await this.execCommand('pkgutil', ['--expand-full', pkgPath, path.join(tempDir, 'podman-pkg')]);
        const extractedBin = await this.findFileRecursive(path.join(tempDir, 'podman-pkg'), 'podman', true);
        if (!extractedBin) {
          throw new Error('Could not find podman binary in extracted .pkg');
        }
        fs.copyFileSync(extractedBin, podmanBin);
        fs.chmodSync(podmanBin, 0o755);
        this.log('podman binary extracted');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(pkgPath, { force: true });
      }
    }

    // Download gvproxy
    if (!fs.existsSync(gvproxyBin)) {
      onProgress?.('download', 'Downloading gvproxy...');
      const gvproxyUrl = `https://github.com/containers/gvisor-tap-vsock/releases/download/v${GVPROXY_VERSION}/gvproxy-darwin`;
      await this.downloadFile(gvproxyUrl, gvproxyBin);
      fs.chmodSync(gvproxyBin, 0o755);
      this.log('gvproxy downloaded');
    }

    // Download vfkit
    if (!fs.existsSync(vfkitBin)) {
      onProgress?.('download', 'Downloading vfkit...');
      const vfkitUrl = `https://github.com/crc-org/vfkit/releases/download/v${VFKIT_VERSION}/vfkit`;
      await this.downloadFile(vfkitUrl, vfkitBin);
      fs.chmodSync(vfkitBin, 0o755);
      this.log('vfkit downloaded');
    }

    onProgress?.('download', 'Podman binaries ready');
    this.log('All podman binaries downloaded');
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const request = https.get(url, (response) => {
        // Follow redirects (GitHub releases use 302)
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          fs.unlinkSync(destPath);
          if (response.headers.location) {
            this.downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
          } else {
            reject(new Error(`Redirect with no location header from ${url}`));
          }
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`Download failed: HTTP ${response.statusCode} from ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      });
      request.on('error', (err) => {
        file.close();
        fs.unlinkSync(destPath);
        reject(err);
      });
    });
  }

  private execCommand(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 60000 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private findFileRecursive(dir: string, name: string, executable: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      const search = (d: string): string | null => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            const found = search(fullPath);
            if (found) return found;
          } else if (entry.name === name) {
            if (!executable) return fullPath;
            try {
              fs.accessSync(fullPath, fs.constants.X_OK);
              return fullPath;
            } catch {
              // Not executable, keep looking
            }
          }
        }
        return null;
      };
      resolve(search(dir));
    });
  }

  private getPodmanEnv(): NodeJS.ProcessEnv {
    // Set up environment so bundled podman uses its own config/data dirs
    // to avoid conflicts with any system podman installation
    const podmanDataDir = path.join(app.getPath('userData'), 'podman-data');
    const podmanBinDir = this.getPodmanBinDir();

    const configDir = path.join(podmanDataDir, 'config');
    const dataDir = path.join(podmanDataDir, 'data');
    const runDir = path.join(podmanDataDir, 'run');

    // Ensure all XDG directories exist before podman tries to access them
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });

    // Write containers.conf so podman can find helper binaries (gvproxy, vfkit)
    // Podman does NOT use PATH for these — it requires helper_binaries_dir in config
    this.ensureContainersConf(configDir, podmanBinDir);

    return {
      ...process.env,
      PATH: `${podmanBinDir}:${process.env.PATH}`,
      CONTAINERS_MACHINE_PROVIDER: 'applehv',
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      XDG_RUNTIME_DIR: runDir,
    };
  }

  private ensureContainersConf(configDir: string, podmanBinDir: string): void {
    const containersDir = path.join(configDir, 'containers');
    fs.mkdirSync(containersDir, { recursive: true });

    const confPath = path.join(containersDir, 'containers.conf');
    const confContent = `[engine]\nhelper_binaries_dir = ["${podmanBinDir}"]\n`;

    // Only write if content changed to avoid unnecessary fs writes
    try {
      const existing = fs.readFileSync(confPath, 'utf-8');
      if (existing === confContent) return;
    } catch {
      // File doesn't exist yet
    }

    fs.writeFileSync(confPath, confContent, 'utf-8');
  }

  // ─── Machine Lifecycle ────────────────────────────────────────

  private async isMachineInitialized(podmanBin: string): Promise<boolean> {
    try {
      const { stdout } = await this.execAsync(podmanBin, ['machine', 'list', '--format', 'json']);
      const machines = JSON.parse(stdout);
      return Array.isArray(machines) && machines.length > 0;
    } catch {
      return false;
    }
  }

  private async isMachineRunning(podmanBin: string): Promise<boolean> {
    try {
      const { stdout } = await this.execAsync(podmanBin, ['machine', 'list', '--format', 'json']);
      const machines = JSON.parse(stdout);
      if (!Array.isArray(machines) || machines.length === 0) return false;
      return machines.some((m: { Running?: boolean }) => m.Running === true);
    } catch {
      return false;
    }
  }

  private async initMachine(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(podmanBin, ['machine', 'init'], {
        env: this.getPodmanEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.log(`[machine init stdout] ${line}`);
          onProgress?.('init', line);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.log(`[machine init stderr] ${line}`);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.log('Machine initialized successfully');
          resolve();
        } else {
          reject(new Error(`podman machine init exited with code ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to run podman machine init: ${error.message}`));
      });
    });
  }

  private async startMachine(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(podmanBin, ['machine', 'start'], {
        env: this.getPodmanEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.log(`[machine start stdout] ${line}`);
          onProgress?.('start-machine', line);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.log(`[machine start stderr] ${line}`);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.log('Machine started successfully');
          resolve();
        } else {
          reject(new Error(`podman machine start exited with code ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to run podman machine start: ${error.message}`));
      });
    });
  }

  // ─── Container Lifecycle ──────────────────────────────────────

  private ensureWorkspaceDir(): void {
    const workspacePath = this.getWorkspacePath();
    fs.mkdirSync(workspacePath, { recursive: true });
    this.log(`Workspace directory ensured at: ${workspacePath}`);
  }

  private getDockerfileHash(): string {
    // Hash ALL files in the podman build context (Dockerfile, entrypoint.sh, preview-server.js, CLAUDE.md, etc.)
    // so that changes to any copied file trigger a rebuild
    const contextDir = path.dirname(this.getDockerfilePath());
    const hash = crypto.createHash('sha256');
    try {
      const files = fs.readdirSync(contextDir).sort();
      for (const file of files) {
        const filePath = path.join(contextDir, file);
        if (fs.statSync(filePath).isFile()) {
          hash.update(file);
          hash.update(fs.readFileSync(filePath));
        }
      }
    } catch {
      // Fallback: just hash the Dockerfile
      hash.update(fs.readFileSync(this.getDockerfilePath()));
    }
    return hash.digest('hex').substring(0, 16);
  }

  private async getImageDockerfileHash(podmanBin: string): Promise<string | null> {
    try {
      const { stdout } = await this.execAsync(podmanBin, [
        'image', 'inspect', '--format', '{{index .Config.Labels "dockerfile.hash"}}', IMAGE_NAME,
      ]);
      const hash = stdout.trim();
      return hash && hash !== '<no value>' ? hash : null;
    } catch {
      return null;
    }
  }

  private async ensureImageBuilt(podmanBin: string, onProgress?: ProgressCallback): Promise<void> {
    const currentHash = this.getDockerfileHash();
    const imageHash = await this.getImageDockerfileHash(podmanBin);

    if (imageHash === currentHash) {
      this.log(`Container image up to date (hash: ${currentHash})`);
      return;
    }

    if (imageHash) {
      this.log(`Dockerfile changed (${imageHash} → ${currentHash}), rebuilding image...`);
      onProgress?.('build', 'Dockerfile changed, rebuilding image...');
    } else {
      this.log('Building container image...');
      onProgress?.('build', 'Building container image (first-time setup)...');
    }

    const dockerfilePath = this.getDockerfilePath();
    const contextDir = path.dirname(dockerfilePath);

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(podmanBin, [
        'build', '--no-cache',
        '--label', `dockerfile.hash=${currentHash}`,
        '-t', IMAGE_NAME,
        '-f', dockerfilePath,
        contextDir,
      ], {
        env: this.getPodmanEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.log(`[build stdout] ${line}`);
          onProgress?.('build', line);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.log(`[build stderr] ${line}`);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.log('Container image built successfully');
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

  private async removeStaleContainer(podmanBin: string): Promise<void> {
    try {
      await this.execAsync(podmanBin, ['rm', '-f', CONTAINER_NAME]);
      this.log('Removed stale container');
    } catch {
      // Container didn't exist — that's fine
    }
  }

  private async runContainer(podmanBin: string, ttydPort: number, previewPort: number): Promise<void> {
    const workspacePath = this.getWorkspacePath();

    // Pass through environment variables into the container
    const envPassthrough: string[] = [];
    const passthroughKeys = ['ANTHROPIC_API_KEY'];
    for (const key of passthroughKeys) {
      if (process.env[key]) {
        envPassthrough.push('-e', `${key}=${process.env[key]}`);
      }
    }

    const args = [
      'run', '--rm',
      '--name', CONTAINER_NAME,
      '--cap-add', 'NET_ADMIN',
      '-p', `127.0.0.1:${ttydPort}:${TTYD_CONTAINER_PORT}`,
      '-p', `127.0.0.1:${previewPort}:${PREVIEW_CONTAINER_PORT}`,
      '-v', `${workspacePath}:/workspace:Z`,
      ...envPassthrough,
      IMAGE_NAME,
    ];

    this.log(`Running: podman ${args.join(' ')}`);

    this.containerProcess = spawn(podmanBin, args, {
      env: this.getPodmanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.containerProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.log(`[container stdout] ${line}`);
    });

    this.containerProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.log(`[container stderr] ${line}`);
    });

    this.containerProcess.on('exit', (code, signal) => {
      this.log(`Container exited with code ${code}, signal ${signal}`);
      this.containerProcess = null;
      this.shellPort = null;
      this.previewPort = null;
    });

    this.containerProcess.on('error', (error) => {
      this.log(`Container process error: ${error.message}`);
      this.containerProcess = null;
      this.shellPort = null;
      this.previewPort = null;
    });
  }

  private async waitForReady(port: number): Promise<void> {
    this.log('Waiting for ttyd to be ready...');

    for (let i = 0; i < READY_POLL_MAX_RETRIES; i++) {
      try {
        await this.httpGet(`http://127.0.0.1:${port}/`);
        this.log('ttyd is ready');
        return;
      } catch {
        await this.sleep(READY_POLL_INTERVAL_MS);
      }
    }

    throw new Error(`ttyd did not become ready after ${READY_POLL_MAX_RETRIES * READY_POLL_INTERVAL_MS / 1000}s`);
  }

  private async findFreePorts(): Promise<{ ttydPort: number; previewPort: number }> {
    // Find two consecutive free ports: even for ttyd, odd for preview
    for (let port = HOST_PORT_START; port < HOST_PORT_START + HOST_PORT_RANGE - 1; port += 2) {
      const ttydAvailable = await this.isPortAvailable(port);
      const previewAvailable = await this.isPortAvailable(port + 1);
      if (ttydAvailable && previewAvailable) {
        return { ttydPort: port, previewPort: port + 1 };
      }
    }
    throw new Error(`No free port pair found in range ${HOST_PORT_START}-${HOST_PORT_START + HOST_PORT_RANGE - 1}`);
  }

  private getWorkspacePath(): string {
    return path.join(app.getPath('userData'), 'podman');
  }

  private getDockerfilePath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'podman', 'Dockerfile');
    }
    return path.join(app.getAppPath(), 'src', 'podman', 'Dockerfile');
  }

  // ─── Logging ──────────────────────────────────────────────────

  private getLogPath(): string {
    return path.join(app.getPath('userData'), 'podman-dev.log');
  }

  private openLogStream(): void {
    if (this.logStream) return;
    const logPath = this.getLogPath();
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    this.log('--- Podman service starting ---');
  }

  private closeLogStream(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [PodmanService] ${message}\n`;

    // Write to podman-dev.log
    if (this.logStream) {
      this.logStream.write(line);
    }

    // Also log to the app's default logger
    logger.debug(`[PodmanService] ${message}`);
  }

  // ─── Utilities ────────────────────────────────────────────────

  private execAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { env: this.getPodmanEnv(), timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
          this.log(`exec error [${cmd} ${args.join(' ')}]: ${error.message}`);
          if (stderr) this.log(`exec stderr: ${stderr}`);
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  private httpGet(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 2000 }, (res) => {
        res.resume(); // Consume response to free memory
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const podmanService = new PodmanService();
