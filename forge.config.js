const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function isPortInUse(port) {
  try {
    execSync(`lsof -i :${port} -sTCP:LISTEN`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findAvailablePort(startPort) {
  let port = startPort;
  while (isPortInUse(port)) {
    port++;
  }
  return port;
}

const devServerPort = findAvailablePort(3000);
const loggerPort = findAvailablePort(devServerPort + 1000);

// Root native modules that need to be copied outside the asar archive.
// Transitive runtime dependencies are resolved automatically.
const nativeModuleRoots = ['canvas', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk'];

// Packages only needed at install/build time — never needed at runtime.
const installTimeOnly = new Set([
  'prebuild-install', 'node-addon-api', 'node-gyp', 'node-gyp-build',
]);

/**
 * Recursively resolve runtime dependencies for a list of root modules.
 * Returns a flat, deduplicated list of module names to copy.
 */
function resolveRuntimeDeps(roots) {
  const resolved = new Set();
  const queue = [...roots];

  while (queue.length > 0) {
    const mod = queue.shift();
    if (resolved.has(mod) || installTimeOnly.has(mod)) continue;

    const pkgPath = path.join(__dirname, 'node_modules', mod, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    resolved.add(mod);

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.dependencies) {
      for (const dep of Object.keys(pkg.dependencies)) {
        if (!resolved.has(dep) && !installTimeOnly.has(dep)) {
          queue.push(dep);
        }
      }
    }
  }

  return [...resolved];
}

// Check if we have a valid code signing identity
// Use environment variable or fall back to undefined for local development
const codeSignIdentity = process.env.APPLE_IDENTITY || undefined;

// Platform detection for conditional resource bundling
const platform = os.platform();

const packagerConfig = {
  icon: './src/assets/icons/dock-icon',
  appBundleId: 'com.electron.academia-electron',
  protocols: [
    {
      name: 'Writing Agent',
      schemes: ['writing-agent'],
    },
  ],
  asar: {
    unpack: '{**/node_modules/tesseract.js/**/*,**/node_modules/canvas/**/*,**/node_modules/better-sqlite3/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk/**/*}',
  },
  extraResource: [
    ...(platform === 'darwin' ? [
      'src/applescripts',
      'src/native/build/Release/word_accessibility.node',
      'window-monitor/rust/target/release/window-monitor',
      'window-monitor/rust/target/release/word-actions',
      'webview-manager/rust/target/release/webview-manager',
    ] : []),
    'dist/popup',
    'src/assets/icons',
    'app-update.yml',
    'src/cobuilding/skills',
    'src/cobuilding/CLAUDE.md',
    'src/cobuilding/Dockerfile',
    'src/cobuilding/Dockerfile.base',
    ...(require('fs').existsSync('browser-extension/extension.zip') ? ['browser-extension/extension.zip'] : []),
  ],
  ...(platform === 'darwin' ? {
    extendInfo: {
      NSAppleEventsUsageDescription: 'This app needs to send Apple Events to Microsoft Word to read document content.',
      NSAppleScriptEnabled: true,
    },
  } : {}),
};

// Override product name and identifiers for cobuilding entry point
const entryPoint = process.env.ENTRY_POINT || '';
console.log(`[forge.config.js] ENTRY_POINT = "${entryPoint}"`);

if (entryPoint === 'cobuilding') {
  packagerConfig.name = 'Academia Coscientist';
  packagerConfig.appBundleId = 'com.electron.academia-coscientist';
  packagerConfig.protocols = [
    {
      name: 'Academia Coscientist',
      schemes: ['academia-coscientist'],
    },
  ];
  if (platform === 'darwin') {
    packagerConfig.extraResource.push(
      'src/cobuilding/rust/file-monitor-mac/target/release/file-monitor-mac',
      'src/cobuilding/assets/vfkit-entitlements.plist',
    );
    // TCC usage descriptions for workspace folder access dialogs
    packagerConfig.extendInfo = {
      ...packagerConfig.extendInfo,
      NSDesktopFolderUsageDescription: 'Academia Coscientist needs access to your Desktop to manage workspace files.',
      NSDocumentsFolderUsageDescription: 'Academia Coscientist needs access to your Documents to manage workspace files.',
      NSDownloadsFolderUsageDescription: 'Academia Coscientist needs access to your Downloads to manage workspace files.',
    };
  }
}

// Only add code signing configuration if we have a valid identity
if (codeSignIdentity) {
  packagerConfig.osxSign = {
    identity: codeSignIdentity,
    hardenedRuntime: true,
    entitlements: 'entitlements.plist',
    'entitlements-inherit': 'entitlements.plist',
  };

  // Add notarization configuration if credentials are available
  // Required for distributing apps outside the Mac App Store
  if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) {
    packagerConfig.osxNotarize = {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  }
}

module.exports = {
  packagerConfig,
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (config, buildPath) => {
      // Automatically resolve all transitive runtime deps of native modules
      const modulesToCopy = resolveRuntimeDeps(nativeModuleRoots);
      for (const mod of modulesToCopy) {
        const src = path.join(__dirname, 'node_modules', mod);
        const dest = path.join(buildPath, 'node_modules', mod);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true });
          console.log(`Copied ${mod} to package`);
        }
      }
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'AcademiaElectron',
        authors: 'Academia.edu',
        description: 'Academia Electron Application',
        certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
        certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        port: devServerPort,
        loggerPort: loggerPort,
        devContentSecurityPolicy: "default-src 'self' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline' https://edge.fullstory.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: local-file:; frame-src local-file:; connect-src 'self' ws: http://localhost:* https://*.fullstory.com;",
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './src/index.html',
              js: './src/renderer/index.tsx',
              name: 'main_window',
              preload: {
                js: './src/preload.ts',
              },
            },
            {
              html: './src/cobuilding/renderer/index.html',
              js: './src/cobuilding/renderer/index.tsx',
              name: 'cobuilding_window',
              preload: {
                js: './src/cobuilding/main/preload.ts',
              },
            },
            {
              html: './src/cobuilding/renderer/update.html',
              js: './src/cobuilding/renderer/update.tsx',
              name: 'cobuild_update_window',
              preload: {
                js: './src/cobuilding/main/preload.ts',
              },
            },
            {
              html: './src/cobuilding/renderer/quick-chat.html',
              js: './src/cobuilding/renderer/quick-chat-entry.tsx',
              name: 'quick_chat_window',
              preload: {
                js: './src/cobuilding/main/quickChatPreload.ts',
              },
            },
          ],
        },
      },
    },
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'academia-edu',
          name: 'academia-electron',
        },
        draft: false,
        prerelease: false,
      },
    },
  ],
};
