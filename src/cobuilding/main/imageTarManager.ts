import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import log from 'electron-log';

const CLOUDFRONT_IMAGES_BASE_URL = 'https://d2x7ktxhslqcvg.cloudfront.net/cobuilding-images';
const IMAGE_MANIFEST_URL = `${CLOUDFRONT_IMAGES_BASE_URL}/manifest.json`;

type ProgressCallback = (stage: string, message: string) => void;

interface ImageManifestEntry {
  url: string;
  size: number;
  checksum: string;
}

interface ImageManifestTier {
  version: string;
  arm64: ImageManifestEntry;
  amd64: ImageManifestEntry;
}

interface ImageManifest {
  core?: ImageManifestTier;
  full?: ImageManifestTier;
}

// ─── Public API ──────────────────────────────────────────────────

export function getImageCacheDir(): string {
  return path.join(app.getPath('userData'), 'cobuilding-image-cache');
}

export async function ensureImageTarDownloaded(
  tier: 'core' | 'full',
  onProgress?: ProgressCallback,
): Promise<{ tarPath: string; version: string }> {
  const cacheDir = getImageCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });

  // Allow skipping the manifest fetch for local development:
  // place a .tar file in the cache dir and it will be used directly.
  const localTar = findLocalTar(cacheDir, tier);
  if (localTar) {
    log.info(`[ImageTarManager] Using local tar: ${localTar}`);
    return { tarPath: localTar, version: 'local-dev' };
  }

  onProgress?.('image-manifest', 'Checking for image updates...');
  log.debug(`[ImageTarManager] Fetching image manifest from ${IMAGE_MANIFEST_URL}`);
  const manifest = await fetchJson(IMAGE_MANIFEST_URL) as ImageManifest;

  const tierManifest = manifest[tier];
  if (!tierManifest) {
    throw new Error(`No "${tier}" entry in image manifest`);
  }

  const arch: 'arm64' | 'amd64' = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const entry = tierManifest[arch];
  if (!entry) {
    throw new Error(`No ${arch} entry for "${tier}" in image manifest`);
  }

  const tarFilename = path.basename(entry.url).replace(/\.gz$/, '');
  const tarPath = path.join(cacheDir, tarFilename);

  const loadedVersion = readLoadedImageVersion(tier);
  if (loadedVersion === tierManifest.version) {
    log.debug(`[ImageTarManager] Image "${tier}" already at version ${loadedVersion}`);
    return { tarPath, version: tierManifest.version };
  }

  log.info(`[ImageTarManager] Downloading ${tier} image (${arch}): ${entry.url} (${Math.round(entry.size / 1024 / 1024)}MB)`);
  onProgress?.('image-download', `Downloading ${tier} image...`);

  const gzPath = path.join(cacheDir, path.basename(entry.url));
  await downloadFile(`${CLOUDFRONT_IMAGES_BASE_URL}/${entry.url}`, gzPath, (pct) => {
    onProgress?.('image-download', `Downloading ${tier} image: ${pct}%`);
  });

  onProgress?.('image-verify', 'Verifying download...');
  const expectedHash = entry.checksum.replace(/^sha256:/, '');
  const actualHash = await hashFile(gzPath);
  if (actualHash !== expectedHash) {
    fs.unlinkSync(gzPath);
    throw new Error(`Checksum mismatch for ${tier} image: expected ${expectedHash}, got ${actualHash}`);
  }
  log.debug(`[ImageTarManager] Checksum verified: ${actualHash}`);

  onProgress?.('image-decompress', 'Decompressing image...');
  log.debug(`[ImageTarManager] Decompressing ${gzPath} → ${tarPath}`);
  await decompressGzip(gzPath, tarPath);
  fs.unlinkSync(gzPath);
  const tarSize = fs.statSync(tarPath).size;
  log.info(`[ImageTarManager] Image tar ready: ${tarPath} (${Math.round(tarSize / 1024 / 1024)}MB)`);

  return { tarPath, version: tierManifest.version };
}

export function readLoadedImageVersion(tier: 'core' | 'full'): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.loadedImageVersion?.[tier] || null;
  } catch {
    return null;
  }
}

export function writeLoadedImageVersion(tier: 'core' | 'full', version: string): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { /* file doesn't exist yet */ }
  if (!data.loadedImageVersion || typeof data.loadedImageVersion !== 'object') {
    data.loadedImageVersion = {};
  }
  (data.loadedImageVersion as Record<string, string>)[tier] = version;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Internal Helpers ────────────────────────────────────────────

function findLocalTar(cacheDir: string, tier: 'core' | 'full'): string | null {
  const prefix = tier === 'core' ? 'cobuilding-base-core' : 'cobuilding-base';
  try {
    for (const file of fs.readdirSync(cacheDir)) {
      if (file.startsWith(prefix) && file.endsWith('.tar') && !file.endsWith('.tar.gz')) {
        return path.join(cacheDir, file);
      }
    }
  } catch { /* dir doesn't exist */ }
  return null;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function decompressGzip(gzPath: string, tarPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(gzPath);
    const gunzip = zlib.createGunzip();
    const output = fs.createWriteStream(tarPath);
    const cleanup = (err: Error) => {
      input.destroy();
      gunzip.destroy();
      output.destroy();
      try { fs.unlinkSync(tarPath); } catch { /* ok */ }
      reject(err);
    };
    input.on('error', cleanup);
    gunzip.on('error', cleanup);
    output.on('error', cleanup);
    input.pipe(gunzip).pipe(output);
    output.on('finish', resolve);
  });
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (res.headers.location) {
          fetchJson(res.headers.location).then(resolve).catch(reject);
        } else {
          reject(new Error(`Redirect with no location from ${url}`));
        }
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${(e as Error).message}`)); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url: string, destPath: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = https.get(url, (response) => {
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
      try { fs.unlinkSync(destPath); } catch { /* ok */ }
      reject(err);
    });
  });
}
