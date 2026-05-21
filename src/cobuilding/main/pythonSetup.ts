/**
 * Host Python venv bootstrap.
 *
 * The slim build runs the Jupyter kernel gateway as a host process inside a
 * per-app-data virtual environment. On first run we create that venv from the
 * user's system `python3` and install the packages mini-apps + the agent need
 * for data work (pandas, numpy, matplotlib, jupyter_kernel_gateway, ipykernel).
 *
 * If the user does not have Python 3 installed, we surface a clear, actionable
 * error so they can install it (e.g. brew install python or python.org). A
 * future iteration will bundle python-build-standalone so this becomes a
 * zero-install experience.
 */

import { app } from 'electron';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

const execFileAsync = promisify(execFile);

const REQUIRED_PACKAGES = [
  'jupyter_kernel_gateway',
  'ipykernel',
  'pandas',
  'numpy',
  'matplotlib',
];

export function getVenvDir(): string {
  return path.join(app.getPath('userData'), 'python-venv');
}

function getVenvBinDir(): string {
  return path.join(getVenvDir(), process.platform === 'win32' ? 'Scripts' : 'bin');
}

export function venvBin(name: string): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getVenvBinDir(), `${name}${ext}`);
}

export function venvExists(): boolean {
  return fs.existsSync(venvBin('python'));
}

export async function findSystemPython(): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? ['python', 'py']
    : ['python3', 'python'];
  for (const cand of candidates) {
    try {
      const { stdout } = await execFileAsync(cand, ['--version'], { timeout: 5000 });
      const versionMatch = stdout.match(/Python (\d+)\.(\d+)/);
      if (versionMatch) {
        const major = parseInt(versionMatch[1], 10);
        const minor = parseInt(versionMatch[2], 10);
        if (major === 3 && minor >= 9) {
          return cand;
        }
      }
    } catch { /* not in PATH */ }
  }
  return null;
}

export type SetupProgress = (stage: string, message: string, percent?: number) => void;

export class PythonSetupError extends Error {
  constructor(message: string, public readonly userActionable: string) {
    super(message);
    this.name = 'PythonSetupError';
  }
}

async function isImportable(moduleName: string): Promise<boolean> {
  try {
    await execFileAsync(venvBin('python'), ['-c', `import ${moduleName}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function spawnAndLog(bin: string, args: string[], label: string, onProgress?: SetupProgress): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.info(`[${label}] ${line}`);
        onProgress?.('install', line);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.warn(`[${label}] ${line}`);
      }
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// Single-flight guard: kernel-gateway start and packageInstaller.runWave for
// pip both call ensurePythonVenv. If both fire concurrently on first boot we
// could race `python -m venv` against the same directory. Sharing one
// in-flight promise keeps the heavy work serialized.
let inflightEnsureVenv: Promise<void> | null = null;

/**
 * Ensure the per-app Python venv exists and the required packages are
 * installed. Idempotent — safe to call on every kernel-gateway start. Fast
 * path on a fully-provisioned venv (a couple of file existence checks).
 */
export async function ensurePythonVenv(onProgress?: SetupProgress): Promise<void> {
  if (inflightEnsureVenv) return inflightEnsureVenv;
  inflightEnsureVenv = ensurePythonVenvInner(onProgress).finally(() => {
    inflightEnsureVenv = null;
  });
  return inflightEnsureVenv;
}

async function ensurePythonVenvInner(onProgress?: SetupProgress): Promise<void> {
  if (venvExists()) {
    const ok = await isImportable('kernel_gateway');
    if (ok) return;
    log.info('[PythonSetup] Venv exists but kernel_gateway is missing — reinstalling packages');
  }

  onProgress?.('detect', 'Looking for a system Python 3 install');
  const systemPython = await findSystemPython();
  if (!systemPython) {
    throw new PythonSetupError(
      'No Python 3 installation found on this system.',
      process.platform === 'darwin'
        ? 'Install Python 3 via Homebrew (brew install python) or from python.org, then restart Academia Coscientist.'
        : process.platform === 'win32'
          ? 'Install Python 3.10+ from python.org (make sure "Add to PATH" is checked), then restart Academia Coscientist.'
          : 'Install Python 3.10+ via your package manager (e.g. apt install python3 python3-venv), then restart Academia Coscientist.',
    );
  }
  log.info(`[PythonSetup] Using system Python: ${systemPython}`);

  if (!venvExists()) {
    onProgress?.('create', 'Creating Python virtual environment');
    log.info(`[PythonSetup] Creating venv at ${getVenvDir()}`);
    try {
      await spawnAndLog(systemPython, ['-m', 'venv', getVenvDir()], 'venv-create', onProgress);
    } catch (err) {
      throw new PythonSetupError(
        `Failed to create Python venv: ${(err as Error).message}`,
        'Make sure your Python 3 install includes the "venv" module (on Debian/Ubuntu: apt install python3-venv).',
      );
    }
  }

  // Upgrade pip first — old pip versions can choke on modern wheels.
  onProgress?.('install', 'Upgrading pip');
  try {
    await spawnAndLog(venvBin('python'), ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip-upgrade', onProgress);
  } catch (err) {
    log.warn(`[PythonSetup] pip upgrade failed (non-fatal): ${(err as Error).message}`);
  }

  onProgress?.('install', `Installing ${REQUIRED_PACKAGES.join(', ')}`);
  try {
    await spawnAndLog(venvBin('pip'), ['install', '--disable-pip-version-check', ...REQUIRED_PACKAGES], 'pip-install', onProgress);
  } catch (err) {
    throw new PythonSetupError(
      `Failed to install Python packages: ${(err as Error).message}`,
      'Check your internet connection and try again. If the error persists, see the app log for details.',
    );
  }

  onProgress?.('done', 'Python environment ready', 100);
  log.info('[PythonSetup] Venv ready');
}
