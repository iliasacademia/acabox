import { app, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import { isUpdaterConfigured, checkForUpdates } from './updater';

// Cyan (#00BCD4) in BGRA byte order — replaces black pixels in the logo for dev builds
const DEV_LOGO_TINT = { b: 212, g: 188, r: 0 };

let tray: Tray | null = null;
let currentTrayMenu: Electron.Menu | null = null;
let showWindowCallback: (() => void) | null = null;

export function setShowWindowCallback(callback: () => void) {
  showWindowCallback = callback;
}

export function rebuildTrayMenu(statusLabel?: string) {
  if (!tray) return;

  const menuItems: Electron.MenuItemConstructorOptions[] = [];

  if (showWindowCallback) {
    menuItems.push({
      label: 'Show Window',
      click: () => showWindowCallback?.(),
    });
    menuItems.push({ type: 'separator' });
  }

  menuItems.push({
    label: statusLabel || 'Check for Updates...',
    enabled: !statusLabel && isUpdaterConfigured(),
    click: () => {
      rebuildTrayMenu('Checking...');
      checkForUpdates(true);
    },
  });
  if (statusLabel && !statusLabel.startsWith('Update available')) {
    setTimeout(() => rebuildTrayMenu(), 5000);
  }

  menuItems.push(
    { type: 'separator' },
    {
      label: `Version: ${app.getVersion()}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  );

  currentTrayMenu = Menu.buildFromTemplate(menuItems);
}

// Academia logo on a transparent background, at the given buffer size (2x Retina).
// logoTint: if provided, black pixels are replaced with the tint color while white pixels
//           are preserved. Brightness drives the blend so anti-aliased edges are smooth.
// Padding scales proportionally with size, matching the original 4px-per-side at size=44.
function createCompositeIcon(
  size: number,
  logoTint?: { b: number; g: number; r: number },
): Electron.NativeImage | null {
  const iconPath = path.join(__dirname, 'assets/icons/dock-icon.png');
  const baseIcon = nativeImage.createFromPath(iconPath);
  if (baseIcon.isEmpty()) return null;

  const padding = Math.round(size * 8 / 44); // 8px total at size=44 (4px per side)
  const padded = size - padding;
  const foreground = baseIcon.resize({ width: padded, height: padded });
  const fgBitmap = foreground.toBitmap();
  const fgSize = foreground.getSize();

  const buf = Buffer.alloc(size * size * 4); // transparent by default
  const offsetX = Math.floor((size - fgSize.width) / 2);
  const offsetY = Math.floor((size - fgSize.height) / 2);

  for (let y = 0; y < fgSize.height; y++) {
    for (let x = 0; x < fgSize.width; x++) {
      const srcIdx = (y * fgSize.width + x) * 4;
      const dstIdx = ((y + offsetY) * size + (x + offsetX)) * 4;
      const srcA = fgBitmap[srcIdx + 3];
      if (srcA === 0) continue;

      // Both toBitmap() and createFromBuffer use BGRA on macOS
      let fgB = fgBitmap[srcIdx];
      let fgG = fgBitmap[srcIdx + 1];
      let fgR = fgBitmap[srcIdx + 2];

      if (logoTint) {
        // Replace black pixels with the tint color; white pixels stay white.
        // t=0 at black, t=1 at white — lerp from tint toward original.
        const t = (fgB + fgG + fgR) / (3 * 255);
        fgB = Math.round(logoTint.b + (fgBitmap[srcIdx] - logoTint.b) * t);
        fgG = Math.round(logoTint.g + (fgBitmap[srcIdx + 1] - logoTint.g) * t);
        fgR = Math.round(logoTint.r + (fgBitmap[srcIdx + 2] - logoTint.r) * t);
      }

      buf[dstIdx] = fgB;
      buf[dstIdx + 1] = fgG;
      buf[dstIdx + 2] = fgR;
      buf[dstIdx + 3] = srcA;
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 2.0 });
}

function createTrayIcon(): Electron.NativeImage | null {
  // 44px buffer = 22×22 logical pixels at 2× Retina
  return createCompositeIcon(44, app.isPackaged ? undefined : DEV_LOGO_TINT);
}

// Returns the icon to use for the macOS dock.
// Production: plain academia logo at native resolution.
// Dev: same native-resolution image with black pixels replaced by cyan (white "A" preserved).
// Both paths use the full image bounds so the icon appears the same size as other dock icons.
export function createDockIcon(): Electron.NativeImage | null {
  const iconPath = path.join(__dirname, 'assets/icons/dock-icon.png');
  const baseIcon = nativeImage.createFromPath(iconPath);
  if (baseIcon.isEmpty()) return null;

  if (app.isPackaged) return baseIcon;

  const { width, height } = baseIcon.getSize();
  const bitmap = baseIcon.toBitmap();
  const buf = Buffer.alloc(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const srcA = bitmap[idx + 3];
    if (srcA === 0) continue;

    // Both toBitmap() and createFromBuffer use BGRA on macOS
    const fgB = bitmap[idx];
    const fgG = bitmap[idx + 1];
    const fgR = bitmap[idx + 2];
    // t=0 at black, t=1 at white — lerp from tint toward original
    const t = (fgB + fgG + fgR) / (3 * 255);
    buf[idx] = Math.round(DEV_LOGO_TINT.b + (fgB - DEV_LOGO_TINT.b) * t);
    buf[idx + 1] = Math.round(DEV_LOGO_TINT.g + (fgG - DEV_LOGO_TINT.g) * t);
    buf[idx + 2] = Math.round(DEV_LOGO_TINT.r + (fgR - DEV_LOGO_TINT.r) * t);
    buf[idx + 3] = srcA;
  }

  return nativeImage.createFromBuffer(buf, { width, height });
}

export function createTray() {
  const icon = createTrayIcon();
  if (!icon) {
    log.warn('[TRAY] Failed to load tray icon, skipping tray creation.');
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip('Acabox');
  log.info('[TRAY] Tray created.');

  // Use click handlers instead of setContextMenu to work around Electron tray menu crash on macOS
  tray.on('click', () => {
    if (tray && currentTrayMenu) tray.popUpContextMenu(currentTrayMenu);
  });
  tray.on('right-click', () => {
    if (tray && currentTrayMenu) tray.popUpContextMenu(currentTrayMenu);
  });

  rebuildTrayMenu();
}
