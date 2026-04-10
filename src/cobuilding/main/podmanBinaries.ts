import { execFile } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as crypto from 'crypto';
import log from 'electron-log';

const PODMAN_VERSION = '5.3.1';
const GVPROXY_VERSION = '0.8.0';
const VFKIT_VERSION = '0.6.0';

const IS_WINDOWS = process.platform === 'win32';

const EXPECTED_CHECKSUMS: Record<string, Record<string, string>> = {
  darwin: {
    podman: '7e0fcd22d17de5e8a9cb3bb894887cb351fe7e5f4c6a72bb1a642cefe6ba7df2',
    gvproxy: 'ee672a026af07e5d0fad0716d719a91f8245e82b6d06f5467f792598f9ddee65',
    vfkit: '5f681b5da70ca35351ebe8e803aee637c0e7843cd19d8721ff53fda243b68a92',
  },
  win32: {
    podman: '', // TODO: populate after verifying Windows release binaries
    gvproxy: '',
    'win-sshproxy': '',
  },
};

type ProgressCallback = (stage: string, message: string) => void;

// ─── Public API ───────────────────────────────────────────────────

export function getBundledPodmanBinDir(): string {
  return path.join(app.getPath('userData'), 'cobuilding-podman-bin');
}

export function getBundledPodmanBin(): string {
  const binDir = getBundledPodmanBinDir();
  const bundledBin = path.join(binDir, IS_WINDOWS ? 'podman.exe' : 'podman');
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

  // Podman creates Unix domain sockets under HOME (~/.podman/) and
  // XDG_RUNTIME_DIR. macOS limits socket paths to 104 bytes, so these dirs
  // must be SHORT — the full userData path is too long.
  const podmanHome = path.join(os.homedir(), '.cobuild-podman');
  const runDir = path.join(os.tmpdir(), 'cobuild-podman-run');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  // Isolated .ssh so the user's real ~/.ssh/known_hosts doesn't interfere
  // with Podman's SSH connection to the VM.
  fs.mkdirSync(path.join(podmanHome, '.ssh'), { recursive: true });

  ensureContainersConf(configDir, podmanBinDir);

  const pathSep = IS_WINDOWS ? ';' : ':';

  return {
    ...process.env,
    PATH: `${podmanBinDir}${pathSep}${process.env.PATH}`,
    CONTAINERS_MACHINE_PROVIDER: IS_WINDOWS ? 'wsl' : 'applehv',
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_RUNTIME_DIR: runDir,
    HOME: podmanHome,
  };
}

export async function ensureBinariesDownloaded(onProgress?: ProgressCallback, skipChecksum = false): Promise<void> {
  if (IS_WINDOWS) {
    await ensureBinariesDownloadedWindows(onProgress, skipChecksum);
  } else {
    await ensureBinariesDownloadedMac(onProgress, skipChecksum);
  }
}

async function ensureBinariesDownloadedMac(onProgress?: ProgressCallback, skipChecksum = false): Promise<void> {
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

  // Weights: podman pkg ~80%, gvproxy ~10%, vfkit ~10%
  const needsPodman = !fs.existsSync(podmanBin);
  const needsGvproxy = !fs.existsSync(gvproxyBin);
  const needsVfkit = !fs.existsSync(vfkitBin);

  // Download podman from .pkg and extract
  if (needsPodman) {
    onProgress?.('download', 'Downloading podman...');
    const pkgUrl = `https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-installer-macos-universal.pkg`;
    const pkgPath = path.join(binDir, 'podman.pkg');
    await downloadFile(pkgUrl, pkgPath, (pct) => {
      onProgress?.('download-percent', String(Math.round(pct * 0.8)));
    });

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
      await stripQuarantine(podmanBin);
      await signBinary(podmanBin);
      log.debug(`[PodmanBinaries] podman binary extracted${skipChecksum ? '' : ' and verified'}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(pkgPath, { force: true });
    }
  }

  // Download gvproxy
  if (needsGvproxy) {
    onProgress?.('download', 'Downloading gvproxy...');
    const gvproxyUrl = `https://github.com/containers/gvisor-tap-vsock/releases/download/v${GVPROXY_VERSION}/gvproxy-darwin`;
    await downloadFile(gvproxyUrl, gvproxyBin, (pct) => {
      onProgress?.('download-percent', String(80 + Math.round(pct * 0.1)));
    });
    fs.chmodSync(gvproxyBin, 0o755);
    if (!skipChecksum) verifyChecksum(gvproxyBin, 'gvproxy');
    await stripQuarantine(gvproxyBin);
    await signBinary(gvproxyBin);
    log.debug(`[PodmanBinaries] gvproxy downloaded${skipChecksum ? '' : ' and verified'}`);
  }

  // Download vfkit
  if (needsVfkit) {
    onProgress?.('download', 'Downloading vfkit...');
    const vfkitUrl = `https://github.com/crc-org/vfkit/releases/download/v${VFKIT_VERSION}/vfkit`;
    await downloadFile(vfkitUrl, vfkitBin, (pct) => {
      onProgress?.('download-percent', String(90 + Math.round(pct * 0.1)));
    });
    fs.chmodSync(vfkitBin, 0o755);
    if (!skipChecksum) verifyChecksum(vfkitBin, 'vfkit');
    await stripQuarantine(vfkitBin);
    await signBinary(vfkitBin, getVfkitEntitlementsPath());
    log.debug(`[PodmanBinaries] vfkit downloaded${skipChecksum ? '' : ' and verified'}`);
  }

  onProgress?.('download-percent', '100');
  log.debug('[PodmanBinaries] All binaries downloaded');
}

async function ensureBinariesDownloadedWindows(onProgress?: ProgressCallback, skipChecksum = false): Promise<void> {
  const binDir = getBundledPodmanBinDir();
  const podmanBin = path.join(binDir, 'podman.exe');
  const gvproxyBin = path.join(binDir, 'gvproxy-windows.exe');
  const winSshProxyBin = path.join(binDir, 'win-sshproxy.exe');

  if (fs.existsSync(podmanBin) && fs.existsSync(gvproxyBin) && fs.existsSync(winSshProxyBin)) {
    log.debug('[PodmanBinaries] Binaries already present');
    return;
  }

  fs.mkdirSync(binDir, { recursive: true });
  onProgress?.('download', 'Downloading Podman binaries...');
  log.debug('[PodmanBinaries] Downloading podman binaries (Windows)...');

  const needsPodman = !fs.existsSync(podmanBin);
  const needsGvproxy = !fs.existsSync(gvproxyBin);
  const needsWinSshProxy = !fs.existsSync(winSshProxyBin);

  // Download podman from zip and extract
  if (needsPodman) {
    onProgress?.('download', 'Downloading podman...');
    const zipUrl = `https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-remote-release-windows_amd64.zip`;
    const zipPath = path.join(binDir, 'podman.zip');
    await downloadFile(zipUrl, zipPath, (pct) => {
      onProgress?.('download-percent', String(Math.round(pct * 0.8)));
    });

    log.debug('[PodmanBinaries] Extracting podman from .zip...');
    const tempDir = path.join(binDir, '_extract_tmp');
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      await execCommand('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force`,
      ]);
      const extractedBin = findFileRecursive(tempDir, 'podman.exe', false);
      if (!extractedBin) {
        throw new Error('Could not find podman.exe in extracted .zip');
      }
      fs.copyFileSync(extractedBin, podmanBin);
      if (!skipChecksum) verifyChecksum(podmanBin, 'podman');
      log.debug(`[PodmanBinaries] podman.exe extracted${skipChecksum ? '' : ' and verified'}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });
    }
  }

  // Download gvproxy
  if (needsGvproxy) {
    onProgress?.('download', 'Downloading gvproxy...');
    const gvproxyUrl = `https://github.com/containers/gvisor-tap-vsock/releases/download/v${GVPROXY_VERSION}/gvproxy-windows.exe`;
    await downloadFile(gvproxyUrl, gvproxyBin, (pct) => {
      onProgress?.('download-percent', String(80 + Math.round(pct * 0.1)));
    });
    if (!skipChecksum) verifyChecksum(gvproxyBin, 'gvproxy');
    log.debug(`[PodmanBinaries] gvproxy downloaded${skipChecksum ? '' : ' and verified'}`);
  }

  // Download win-sshproxy (replaces vfkit on Windows — handles SSH tunneling to WSL)
  if (needsWinSshProxy) {
    onProgress?.('download', 'Downloading win-sshproxy...');
    const winSshProxyUrl = `https://github.com/containers/gvisor-tap-vsock/releases/download/v${GVPROXY_VERSION}/win-sshproxy.exe`;
    await downloadFile(winSshProxyUrl, winSshProxyBin, (pct) => {
      onProgress?.('download-percent', String(90 + Math.round(pct * 0.1)));
    });
    if (!skipChecksum) verifyChecksum(winSshProxyBin, 'win-sshproxy');
    log.debug(`[PodmanBinaries] win-sshproxy downloaded${skipChecksum ? '' : ' and verified'}`);
  }

  onProgress?.('download-percent', '100');
  log.debug('[PodmanBinaries] All binaries downloaded');
}

// ─── macOS Binary Permissions ────────────────────────────────────

function getVfkitEntitlementsPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'vfkit-entitlements.plist');
  }
  return path.join(app.getAppPath(), 'src', 'cobuilding', 'assets', 'vfkit-entitlements.plist');
}

/** Strip the com.apple.quarantine xattr so Gatekeeper won't block execution. */
function stripQuarantine(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', filePath], (error) => {
      if (error) {
        log.warn(`[PodmanBinaries] Could not strip quarantine from ${path.basename(filePath)}: ${error.message}`);
      }
      resolve();
    });
  });
}

/** Ad-hoc sign a binary, optionally with entitlements (needed for vfkit's Virtualization.framework access). */
function signBinary(filePath: string, entitlementsPath?: string): Promise<void> {
  const args = ['--force', '--sign', '-'];
  if (entitlementsPath) {
    args.push('--entitlements', entitlementsPath);
  }
  args.push(filePath);

  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', args, (error) => {
      if (error) {
        log.warn(`[PodmanBinaries] Could not sign ${path.basename(filePath)}: ${error.message}`);
      } else {
        log.debug(`[PodmanBinaries] Signed ${path.basename(filePath)}${entitlementsPath ? ' with entitlements' : ''}`);
      }
      resolve();
    });
  });
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
  const platform = IS_WINDOWS ? 'win32' : 'darwin';
  const expected = EXPECTED_CHECKSUMS[platform]?.[name];
  if (!expected) {
    log.warn(`[PodmanBinaries] No checksum defined for ${name} on ${platform}, skipping verification`);
    return;
  }
  const fileBuffer = fs.readFileSync(filePath);
  const actual = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  if (actual !== expected) {
    fs.unlinkSync(filePath);
    throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  log.debug(`[PodmanBinaries] Checksum verified for ${name}: ${actual}`);
}

function downloadFile(url: string, destPath: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = https.get(url, (response) => {
      // Follow redirects (GitHub releases use 302)
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        if (response.headers.location) {
          downloadFile(response.headers.location, destPath, onProgress).then(resolve).catch(reject);
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
      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let receivedBytes = 0;
      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (totalBytes > 0 && onProgress) {
          onProgress(Math.min(100, Math.round((receivedBytes / totalBytes) * 100)));
        }
      });
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
