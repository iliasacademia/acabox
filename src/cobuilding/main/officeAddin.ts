import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { app, ipcMain } from 'electron';
import log from 'electron-log';
import {
  MANIFEST_NAME, WEF_DIRS, LOGIN_KEYCHAIN,
  getCertsDir, getCertPath, getKeyPath, getAddinDir,
} from './officeAddinPaths';

const HTTPS_PORT = 23112;

const PROJECT_ROOT = app.isPackaged ? process.resourcesPath : app.getAppPath();
const CERTS_DIR = getCertsDir(PROJECT_ROOT);
const CERT_PATH = getCertPath(PROJECT_ROOT);
const KEY_PATH = getKeyPath(PROJECT_ROOT);
const ADDIN_DIR = getAddinDir(PROJECT_ROOT);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.xml': 'application/xml',
};

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
  'base64',
);

// ── Certificate helpers ──

export function ensureCert(): { key: string; cert: string } {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return { key: fs.readFileSync(KEY_PATH, 'utf-8'), cert: fs.readFileSync(CERT_PATH, 'utf-8') };
  }
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  let certPem: string;
  try {
    certPem = execSync(
      `openssl req -x509 -new -nodes -key /dev/stdin -sha256 -days 365 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { input: keyPem, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    certPem = execSync(
      `openssl req -x509 -new -nodes -key /dev/stdin -sha256 -days 365 -subj "/CN=localhost"`,
      { input: keyPem, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }
  fs.writeFileSync(KEY_PATH, keyPem);
  fs.writeFileSync(CERT_PATH, certPem);
  return { key: keyPem, cert: certPem };
}

function isCertTrusted(): boolean {
  try {
    if (!fs.existsSync(CERT_PATH)) return false;
    execSync(`security verify-cert -c "${CERT_PATH}" 2>&1`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function trustCert(): void {
  execSync(
    `security add-trusted-cert -r trustRoot -k "${LOGIN_KEYCHAIN}" "${CERT_PATH}"`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

// ── HTTPS server ──

export function startHttpsServer(httpPort: number): void {
  try {
    const { key, cert } = ensureCert();

    const server = https.createServer({ key, cert }, (req, res) => {
      const parsed = new URL(req.url || '/', `https://localhost:${HTTPS_PORT}`);
      const pathname = parsed.pathname === '/' ? '/taskpane.html' : parsed.pathname;

      if (['/taskpane.html', '/commands.html'].includes(pathname) || pathname.startsWith('/icon-')) {
        const filePath = path.join(ADDIN_DIR, pathname);
        const ext = path.extname(filePath);
        if (ext === '.png' && !fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
          res.end(PIXEL);
          return;
        }
        try {
          const data = fs.readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          });
          res.end(data);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
        return;
      }

      const proxyReq = http.request(
        { hostname: '127.0.0.1', port: httpPort, path: req.url, method: req.method, headers: req.headers },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(proxyReq);
    });

    server.listen(HTTPS_PORT, '127.0.0.1', () => {
      log.info(`[HTTPS Server] Started on https://localhost:${HTTPS_PORT} (add-in + API proxy)`);
    });

    // Auto-trust cert
    if (!isCertTrusted()) {
      try {
        trustCert();
        log.info('[HTTPS Server] Certificate trusted in login keychain');
      } catch (err) {
        log.warn('[HTTPS Server] Could not auto-trust certificate:', err);
      }
    }
  } catch (err) {
    log.error('[HTTPS Server] Failed to start:', err);
  }
}

// ── IPC handlers ──

export function registerOfficeAddinIpcHandlers(): void {
  ipcMain.handle('officeAddin:status', () => ({
    word: fs.existsSync(path.join(WEF_DIRS.word, MANIFEST_NAME)),
    powerpoint: fs.existsSync(path.join(WEF_DIRS.powerpoint, MANIFEST_NAME)),
    excel: fs.existsSync(path.join(WEF_DIRS.excel, MANIFEST_NAME)),
    certTrusted: isCertTrusted(),
    certExists: fs.existsSync(CERT_PATH),
  }));

  ipcMain.handle('officeAddin:sideload', () => {
    try {
      const manifestSrc = path.join(ADDIN_DIR, 'manifest-local.xml');
      if (!fs.existsSync(manifestSrc)) {
        return { success: false, error: `Manifest not found at ${manifestSrc}` };
      }
      for (const wefDir of Object.values(WEF_DIRS)) {
        fs.mkdirSync(wefDir, { recursive: true });
        fs.copyFileSync(manifestSrc, path.join(wefDir, MANIFEST_NAME));
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('officeAddin:remove', () => {
    try {
      for (const wefDir of Object.values(WEF_DIRS)) {
        const manifestPath = path.join(wefDir, MANIFEST_NAME);
        if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('officeAddin:trustCert', () => {
    try {
      ensureCert();
      trustCert();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('officeAddin:removeCert', () => {
    try {
      if (!fs.existsSync(CERT_PATH)) {
        return { success: false, error: 'Certificate not found.' };
      }
      execSync(
        `security delete-certificate -c "localhost" -t "${LOGIN_KEYCHAIN}"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('officeAddin:deleteCert', () => {
    try {
      if (fs.existsSync(CERT_PATH)) fs.unlinkSync(CERT_PATH);
      if (fs.existsSync(KEY_PATH)) fs.unlinkSync(KEY_PATH);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
