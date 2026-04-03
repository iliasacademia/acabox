import { app, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import { isUpdaterConfigured, checkForUpdates } from './updater';

let tray: Tray | null = null;
let currentTrayMenu: Electron.Menu | null = null;

export function rebuildTrayMenu(statusLabel?: string) {
  if (!tray) return;

  const menuItems: Electron.MenuItemConstructorOptions[] = [];

  menuItems.push({
    label: statusLabel || 'Check for Updates...',
    enabled: !statusLabel && isUpdaterConfigured(),
    click: () => {
      rebuildTrayMenu('Checking...');
      checkForUpdates(true);
    },
  });
  if (statusLabel) {
    setTimeout(() => rebuildTrayMenu(), 5000);
  }

  menuItems.push(
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

function createTrayIcon(): Electron.NativeImage | null {
  const iconPath = path.join(__dirname, 'assets/icons/dock-icon.png');
  const baseIcon = nativeImage.createFromPath(iconPath);
  if (baseIcon.isEmpty()) return null;

  const size = 44; // 2x for Retina, displays as 22x22
  const radius = size / 2;

  // Blue background circle
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - radius + 0.5;
      const dy = y - radius + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const offset = (y * size + x) * 4;
      if (dist <= radius) {
        const alpha = Math.min(1, radius - dist) * 255;
        buf[offset] = 255;     // B (#ff)
        buf[offset + 1] = 158; // G (#9e)
        buf[offset + 2] = 74;  // R (#4a)
        buf[offset + 3] = alpha;
      }
    }
  }

  // Composite the icon on top, centered and padded
  const padded = size - 8; // leave 4px padding on each side
  const foreground = baseIcon.resize({ width: padded, height: padded });
  const fgBitmap = foreground.toBitmap();
  const fgSize = foreground.getSize();
  const offsetX = Math.floor((size - fgSize.width) / 2);
  const offsetY = Math.floor((size - fgSize.height) / 2);

  for (let y = 0; y < fgSize.height; y++) {
    for (let x = 0; x < fgSize.width; x++) {
      const srcIdx = (y * fgSize.width + x) * 4;
      const dstIdx = ((y + offsetY) * size + (x + offsetX)) * 4;
      const fgA = fgBitmap[srcIdx + 3] / 255;
      if (fgA > 0) {
        const bgA = buf[dstIdx + 3] / 255;
        const outA = fgA + bgA * (1 - fgA);
        // Both toBitmap() and createFromBuffer use BGRA on macOS
        buf[dstIdx] = Math.round((fgBitmap[srcIdx] * fgA + buf[dstIdx] * bgA * (1 - fgA)) / outA);
        buf[dstIdx + 1] = Math.round((fgBitmap[srcIdx + 1] * fgA + buf[dstIdx + 1] * bgA * (1 - fgA)) / outA);
        buf[dstIdx + 2] = Math.round((fgBitmap[srcIdx + 2] * fgA + buf[dstIdx + 2] * bgA * (1 - fgA)) / outA);
        buf[dstIdx + 3] = Math.round(outA * 255);
      }
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 2.0 });
}

export function createTray() {
  const icon = createTrayIcon();
  if (!icon) {
    log.warn('[TRAY] Failed to load tray icon, skipping tray creation.');
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip('Cobuilding');
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
