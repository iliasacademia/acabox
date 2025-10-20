import * as path from 'path';

// Webpack provides __non_webpack_require__ to access Node's native require
declare const __non_webpack_require__: NodeRequire | undefined;

export interface SelectionEvent {
  type: 'selectionChanged';
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScrollEvent {
  type: 'scrollStarted' | 'scrollEnded';
}

export interface ButtonClickEvent {
  type: 'buttonClicked';
  text: string;
}

export type AccessibilityEvent = SelectionEvent | ScrollEvent | ButtonClickEvent;

export interface SelectedText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeModule {
  startObserving(pid: number, callback: (event: AccessibilityEvent) => void): boolean;
  stopObserving(): void;
  getSelectedText(): SelectedText | null;
  checkPermission(): boolean;
  setPopupPath(path: string): boolean;
}

// Load the native module
let nativeModule: NativeModule | null = null;

// Use native Node.js require, not webpack's require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeRequire = typeof __non_webpack_require__ !== 'undefined' ? __non_webpack_require__ : require;

try {
  // Debug: log the base directories
  console.log('[Native Module] __dirname:', __dirname);
  console.log('[Native Module] process.cwd():', process.cwd());
  console.log('[Native Module] process.resourcesPath:', process.resourcesPath);

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

  console.log('[Native Module] Attempting to load from paths:');
  for (const modulePath of possiblePaths) {
    try {
      const fs = nodeRequire('fs');
      const exists = fs.existsSync(modulePath);
      console.log(`[Native Module]   ${modulePath} - ${exists ? 'EXISTS' : 'NOT FOUND'}`);
      if (exists) {
        nativeModule = nodeRequire(modulePath) as NativeModule;
        console.log('Native Word accessibility module loaded successfully from:', modulePath);
        break;
      }
    } catch (e) {
      console.error(`[Native Module] Error trying to load from ${modulePath}:`, e);
      // Try next path
      continue;
    }
  }

  if (!nativeModule) {
    throw new Error('Native module not found in any expected location');
  }

  // Set the popup HTML path for the native module
  try {
    const fs = nodeRequire('fs');
    const popupPaths = [
      // Development: dist/popup
      path.join(process.cwd(), 'dist', 'popup', 'index.html'),
      // Packaged: in resources
      path.join(process.resourcesPath || '', 'popup', 'index.html'),
    ];

    for (const popupPath of popupPaths) {
      if (fs.existsSync(popupPath)) {
        nativeModule.setPopupPath(popupPath);
        console.log('Popup HTML path set to:', popupPath);
        break;
      }
    }
  } catch (error) {
    console.error('Failed to set popup path:', error);
  }
} catch (error) {
  console.error('Failed to load native Word accessibility module:', error);
  console.error('Make sure to build the native module first: npm run build:native');
}

export class WordAccessibilityBridge {
  private callback: ((event: AccessibilityEvent) => void) | null = null;
  private pid: number | null = null;

  checkPermission(): boolean {
    if (!nativeModule) {
      throw new Error('Native module not loaded');
    }
    return nativeModule.checkPermission();
  }

  startObserving(pid: number, callback: (event: AccessibilityEvent) => void): boolean {
    if (!nativeModule) {
      throw new Error('Native module not loaded');
    }

    if (!this.checkPermission()) {
      throw new Error('Accessibility permission not granted. Please grant permission in System Settings.');
    }

    this.pid = pid;
    this.callback = callback;

    try {
      return nativeModule.startObserving(pid, callback);
    } catch (error) {
      console.error('Failed to start observing:', error);
      throw error;
    }
  }

  stopObserving(): void {
    if (!nativeModule) {
      return;
    }

    try {
      nativeModule.stopObserving();
      this.callback = null;
      this.pid = null;
    } catch (error) {
      console.error('Failed to stop observing:', error);
    }
  }

  getSelectedText(): SelectedText | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getSelectedText();
    } catch (error) {
      console.error('Failed to get selected text:', error);
      return null;
    }
  }

  isObserving(): boolean {
    return this.pid !== null && this.callback !== null;
  }
}

// Export singleton instance
export const wordAccessibility = new WordAccessibilityBridge();
