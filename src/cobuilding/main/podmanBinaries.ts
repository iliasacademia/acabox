import { execFile } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';
import log from 'electron-log';

const PODMAN_VERSION = '5.3.1';
const GVPROXY_VERSION = '0.8.0';
const VFKIT_VERSION = '0.6.0';

const EXPECTED_CHECKSUMS: Record<string, string> = {
  podman: '7e0fcd22d17de5e8a9cb3bb894887cb351fe7e5f4c6a72bb1a642cefe6ba7df2',
  gvproxy: 'ee672a026af07e5d0fad0716d719a91f8245e82b6d06f5467f792598f9ddee65',
  vfkit: '5f681b5da70ca35351ebe8e803aee637c0e7843cd19d8721ff53fda243b68a92',
};

type ProgressCallback = (stage: string, message: string) => void;

// ─── Public API ───────────────────────────────────────────────────

export function getBundledPodmanBinDir(): string {
  return path.join(app.getPath('userData'), 'cobuilding-podman-bin');
}

export function getBundledPodmanBin(): string {
  const binDir = getBundledPodmanBinDir();
  const bundledBin = path.join(binDir, 'podman');
  if (!fs.existsSync(bundledBin)) {
    throw new Error('Bundled Podman binary not found. Run ensureBinariesDownloaded() first.');
  }
  return bundledBin;
}

export function getBundledPodmanEnv(): NodeJS.ProcessEnv {
  const podmanDataDir = path.join(app.getPath('userData'), 'cobuilding-podman-data');
  const podmanBinDir = getBundledPodmanBinDir();

  const configDir = path.join(podmanDataDir, 'config');
  const dataDir = path.join(podmanDataDir, 'data');
  const runDir = path.join(podmanDataDir, 'run');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });

  ensureContainersConf(configDir, podmanBinDir);

  return {
    ...process.env,
    PATH: `${podmanBinDir}:${process.env.PATH}`,
    CONTAINERS_MACHINE_PROVIDER: 'applehv',
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_RUNTIME_DIR: runDir,
  };
}

export async function ensureBinariesDownloaded(onProgress?: ProgressCallback, skipChecksum = false): Promise<void> {
  const binDir = getBundledPodmanBinDir();
  const podmanBin = path.join(binDir, 'podman');
  const gvproxyBin = path.join(binDir, 'gvproxy');
  const vfkitBin = path.join(binDir, 'vfkit');

  if (fs.existsSync(podmanBin) && fs.existsSync(gvproxyBin) && fs.existsSync(vfkitBin)) {
    log.debug('[PodmanBinaries] Binaries already present');
    return;
  }

  fs.mkdirSync(binDir, { recursive: true });
  onProgress?.('download', 'Downloading Podman binaries...');
  log.debug('[PodmanBinaries] Downloading podman binaries...');

  // Download podman from .pkg and extract
  if (!fs.existsSync(podmanBin)) {
    onProgress?.('download', 'Downloading podman...');
    const pkgUrl = `https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-installer-macos-universal.pkg`;
    const pkgPath = path.join(binDir, 'podman.pkg');
    await downloadFile(pkgUrl, pkgPath);

    log.debug('[PodmanBinaries] Extracting podman from .pkg...');
    const tempDir = path.join(binDir, '_extract_tmp');
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      await execCommand('pkgutil', ['--expand-full', pkgPath, path.join(tempDir, 'podman-pkg')]);
      const extractedBin = findFileRecursive(path.join(tempDir, 'podman-pkg'), 'podman', true);
      if (!extractedBin) {
        throw new Error('Could not find podman binary in extracted .pkg');
      }
      fs.copyFileSync(extractedBin, podmanBin);
      fs.chmodSync(podmanBin, 0o755);
      if (!skipChecksum) verifyChecksum(podmanBin, 'podman');
      log.debug(`[PodmanBinaries] podman binary extracted${skipChecksum ? '' : ' and verified'}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(pkgPath, { force: true });
    }
  }

  // Download gvproxy
  if (!fs.existsSync(gvproxyBin)) {
    onProgress?.('download', 'Downloading gvproxy...');
    const gvproxyUrl = `https://github.com/containers/gvisor-tap-vsock/releases/download/v${GVPROXY_VERSION}/gvproxy-darwin`;
    await downloadFile(gvproxyUrl, gvproxyBin);
    fs.chmodSync(gvproxyBin, 0o755);
    if (!skipChecksum) verifyChecksum(gvproxyBin, 'gvproxy');
    log.debug(`[PodmanBinaries] gvproxy downloaded${skipChecksum ? '' : ' and verified'}`);
  }

  // Download vfkit
  if (!fs.existsSync(vfkitBin)) {
    onProgress?.('download', 'Downloading vfkit...');
    const vfkitUrl = `https://github.com/crc-org/vfkit/releases/download/v${VFKIT_VERSION}/vfkit`;
    await downloadFile(vfkitUrl, vfkitBin);
    fs.chmodSync(vfkitBin, 0o755);
    if (!skipChecksum) verifyChecksum(vfkitBin, 'vfkit');
    log.debug(`[PodmanBinaries] vfkit downloaded${skipChecksum ? '' : ' and verified'}`);
  }

  onProgress?.('download', 'Podman binaries ready');
  log.debug('[PodmanBinaries] All binaries downloaded');
}

// ─── Internal Helpers ─────────────────────────────────────────────

function ensureContainersConf(configDir: string, podmanBinDir: string): void {
  const containersDir = path.join(configDir, 'containers');
  fs.mkdirSync(containersDir, { recursive: true });

  const confPath = path.join(containersDir, 'containers.conf');
  const confContent = `[engine]\nhelper_binaries_dir = ["${podmanBinDir}"]\n`;

  try {
    const existing = fs.readFileSync(confPath, 'utf-8');
    if (existing === confContent) return;
  } catch {
    // File doesn't exist yet
  }

  fs.writeFileSync(confPath, confContent, 'utf-8');
}

function verifyChecksum(filePath: string, name: string): void {
  const expected = EXPECTED_CHECKSUMS[name];
  if (!expected) {
    throw new Error(`No expected checksum defined for ${name}`);
  }
  const fileBuffer = fs.readFileSync(filePath);
  const actual = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  if (actual !== expected) {
    fs.unlinkSync(filePath);
    throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  log.debug(`[PodmanBinaries] Checksum verified for ${name}: ${actual}`);
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = https.get(url, (response) => {
      // Follow redirects (GitHub releases use 302)
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        if (response.headers.location) {
          downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
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

function execCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function findFileRecursive(dir: string, name: string, executable: boolean): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, name, executable);
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
}
