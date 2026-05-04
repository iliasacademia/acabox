import { execFile } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log';

/**
 * Resolve the native claude binary from the SDK's platform-specific package.
 * In a packaged app the binary lives in app.asar.unpacked/; in dev it's in node_modules/.
 */
export function resolveClaudeBinary(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';

  const candidates = platform === 'linux'
    ? [
        `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
        `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
      ]
    : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];

  for (const pkg of candidates) {
    const binaryPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkg, binaryName)
      : path.join(app.getAppPath(), 'node_modules', pkg, binaryName);

    if (fs.existsSync(binaryPath)) {
      return binaryPath;
    }
  }

  log.error('[SDKBinary] Native claude binary not found for ' + `${platform}-${arch}`);
  return null;
}

/**
 * Resolve the Linux claude binary for use inside the container.
 * On arm64 hosts (Apple Silicon), the podman machine is arm64 so we need the arm64 binary.
 * On x64 hosts, we need the x64 binary.
 */
export function resolveLinuxClaudeBinary(): string | null {
  // Match the container's architecture to the host — podman machine runs the same arch
  // Prefer glibc (non-musl) since the container is Ubuntu-based.
  // Musl binaries fail with ENOENT because /lib/ld-musl-*.so.1 doesn't exist.
  const containerArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    `@anthropic-ai/claude-agent-sdk-linux-${containerArch}`,
    `@anthropic-ai/claude-agent-sdk-linux-${containerArch}-musl`,
  ];

  for (const pkg of candidates) {
    const binaryPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkg, 'claude')
      : path.join(app.getAppPath(), 'node_modules', pkg, 'claude');

    if (fs.existsSync(binaryPath)) {
      return binaryPath;
    }
  }

  log.error('[SDKBinary] Linux claude binary not found');
  return null;
}

/** Strip the com.apple.quarantine xattr so Gatekeeper won't block execution. */
function stripQuarantine(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', filePath], (error) => {
      if (error) {
        log.warn(`[SDKBinary] Could not strip quarantine from ${path.basename(filePath)}: ${error.message}`);
      }
      resolve();
    });
  });
}

/**
 * Call once at app startup to ensure the native claude binary is ready to execute.
 * Strips macOS quarantine and verifies execute permissions.
 */
export async function ensureClaudeBinaryReady(): Promise<void> {
  const binaryPath = resolveClaudeBinary();
  if (!binaryPath) {
    return;
  }

  if (process.platform === 'darwin') {
    await stripQuarantine(binaryPath);
  }

  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(binaryPath, 0o755);
      log.info('[SDKBinary] Fixed execute permission on claude binary');
    } catch (chmodErr) {
      log.error('[SDKBinary] Failed to set execute permission:', chmodErr);
    }
  }

  log.info(`[SDKBinary] Binary ready at ${binaryPath}`);
}
