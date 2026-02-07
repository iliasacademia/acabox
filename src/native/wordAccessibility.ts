import * as path from 'path';
import { defaultLogger as logger } from '../utils/logger';

// Webpack provides __non_webpack_require__ to access Node's native require
declare const __non_webpack_require__: NodeRequire | undefined;

interface NativeModule {
  checkPermission(): boolean;
  requestPermission(): boolean;
  openAccessibilitySettings(): void;
  resetAndRequestPermission(): { resetSuccess: boolean; bundleId: string };
  getAppInfo(): { bundleId: string; executablePath: string; teamId: string };
  setLogFilePath(path: string): boolean;
}

// Load the native module
let nativeModule: NativeModule | null = null;

// Use native Node.js require, not webpack's require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeRequire = typeof __non_webpack_require__ !== 'undefined' ? __non_webpack_require__ : require;

try {
  // Try multiple possible paths
  const possiblePaths = [
    // Webpack output: relative to main bundle (most likely in development)
    path.join(__dirname, 'native', 'build', 'Release', 'word_accessibility.node'),
    // Development: absolute from project root
    path.join(process.cwd(), 'src', 'native', 'build', 'Release', 'word_accessibility.node'),
    // Development: relative to source
    path.join(__dirname, 'build', 'Release', 'word_accessibility.node'),
    // Webpack output directory alternative
    path.join(__dirname, '..', '..', 'native', 'build', 'Release', 'word_accessibility.node'),
    // Packaged app: from extraResources
    path.join(process.resourcesPath || '', 'word_accessibility.node'),
    // Packaged app: alternative path
    path.join(process.resourcesPath || '', 'native', 'build', 'Release', 'word_accessibility.node')
  ];

  for (const modulePath of possiblePaths) {
    try {
      const fs = nodeRequire('fs');
      const exists = fs.existsSync(modulePath);
      if (exists) {
        nativeModule = nodeRequire(modulePath) as NativeModule;
        logger.debug('[Native Module] Loaded from:', modulePath);
        break;
      }
    } catch (e) {
      // Try next path
      continue;
    }
  }

  if (!nativeModule) {
    throw new Error('Native module not found in any expected location');
  }
} catch (error) {
  logger.error('Failed to load native Word accessibility module:', error);
  logger.error('Make sure to build the native module first: npm run build:native');
}

export class WordAccessibilityBridge {
  checkPermission(): boolean {
    if (!nativeModule) {
      throw new Error('Native module not loaded');
    }
    return nativeModule.checkPermission();
  }

  requestPermission(): boolean {
    if (!nativeModule) {
      return false;
    }
    return nativeModule.requestPermission();
  }

  openAccessibilitySettings(): void {
    if (!nativeModule) {
      return;
    }
    nativeModule.openAccessibilitySettings();
  }

  resetAndRequestPermission(): { resetSuccess: boolean; bundleId: string } {
    if (!nativeModule) {
      return { resetSuccess: false, bundleId: '(native module not loaded)' };
    }
    return nativeModule.resetAndRequestPermission();
  }

  getAppInfo(): { bundleId: string; executablePath: string; teamId: string } {
    if (!nativeModule) {
      return { bundleId: '(native module not loaded)', executablePath: '(native module not loaded)', teamId: '(native module not loaded)' };
    }
    return nativeModule.getAppInfo();
  }

  setLogFilePath(logFilePath: string): boolean {
    if (!nativeModule) {
      logger.error('[WordAccessibility] Failed to set log file path: Native module not loaded');
      return false;
    }
    try {
      return nativeModule.setLogFilePath(logFilePath);
    } catch (error) {
      logger.error('[WordAccessibility] Failed to set log file path:', error);
      return false;
    }
  }
}

// Export singleton instance
export const wordAccessibility = new WordAccessibilityBridge();
