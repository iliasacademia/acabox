import { execFile } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import { browserExtensionServer } from '../../server/browserExtensionServer';
import { getCurrentDocumentUrl } from './fileMonitor/fileMonitorService';

export interface QuickChatContext {
  frontmostApp: string | null;
  bundleId: string | null;
  documentUrl: string | null;
  selectedText: string | null;
  focusedElementDescription: string | null;
  focusedElementValue: string | null;
  focusedElementRole: string | null;
}

function getContextCaptureBinPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'context-capture');
  }
  return path.join(app.getAppPath(), 'window-monitor', 'rust', 'target', 'release', 'context-capture');
}

const BROWSER_BUNDLE_IDS = new Set([
  'com.google.Chrome',
  'com.apple.Safari',
  'org.mozilla.firefox',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'company.thebrowser.Browser',
]);

function isBrowser(bundleId: string | null, appName: string | null): boolean {
  if (bundleId && BROWSER_BUNDLE_IDS.has(bundleId)) return true;
  // Fallback to app name if bundle ID not available
  if (appName) {
    const name = appName.toLowerCase();
    return name.includes('chrome') || name.includes('safari') || name.includes('firefox')
      || name.includes('edge') || name.includes('brave') || name.includes('arc');
  }
  return false;
}

export async function captureContext(): Promise<QuickChatContext> {
  const binPath = getContextCaptureBinPath();
  const documentUrl = getCurrentDocumentUrl();

  const context = await new Promise<QuickChatContext>((resolve) => {
    execFile(binPath, [], { timeout: 2000 }, (err, stdout) => {
      if (err) {
        log.warn('[ContextCapture] Binary failed:', err.message);
        resolve({
          frontmostApp: null,
          bundleId: null,
          documentUrl,
          selectedText: null,
          focusedElementDescription: null,
          focusedElementValue: null,
          focusedElementRole: null,
        });
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve({
          frontmostApp: result.frontmostApp ?? null,
          bundleId: result.bundleId ?? null,
          documentUrl: result.documentUrl ?? documentUrl,
          selectedText: result.selectedText ?? null,
          focusedElementDescription: null,
          focusedElementValue: result.focusedElementValue ?? null,
          focusedElementRole: result.focusedElementRole ?? null,
        });
      } catch (parseErr) {
        log.warn('[ContextCapture] Failed to parse output:', stdout);
        resolve({
          frontmostApp: null,
          bundleId: null,
          documentUrl,
          selectedText: null,
          focusedElementDescription: null,
          focusedElementValue: null,
          focusedElementRole: null,
        });
      }
    });
  });

  // For browsers, always prefer the extension for selected text
  const browserDetected = isBrowser(context.bundleId, context.frontmostApp);
  log.info('[ContextCapture] Native result:', {
    frontmostApp: context.frontmostApp,
    bundleId: context.bundleId,
    documentUrl: context.documentUrl,
    selectedText: context.selectedText ? `${context.selectedText.length} chars` : context.selectedText,
    isBrowser: browserDetected,
  });
  if (browserDetected) {
    log.info('[ContextCapture] Browser detected, requesting selection from extension...');
    const browserText = await browserExtensionServer.getSelection(1500);
    if (browserText) {
      log.info('[ContextCapture] Got selection from browser extension:', browserText.length, 'chars');
      context.selectedText = browserText;
    } else {
      log.info('[ContextCapture] No selection from browser extension (not connected or timed out)');
    }
  }

  return context;
}
