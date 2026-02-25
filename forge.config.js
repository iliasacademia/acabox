const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const os = require('os');

// Check if we have a valid code signing identity
// Use environment variable or fall back to undefined for local development
const codeSignIdentity = process.env.APPLE_IDENTITY || undefined;

// Platform detection for conditional resource bundling
const platform = os.platform();

const packagerConfig = {
  asar: {
    unpack: '{**/node_modules/tesseract.js/**/*,**/node_modules/canvas/**/*,**/node_modules/better-sqlite3/**/*}',
  },
  extraResource: [
    ...(platform === 'darwin' ? [
      'src/applescripts',
      'src/native/build/Release/word_accessibility.node',
      'window-monitor/rust/target/release/window-monitor',
      'webview-manager/rust/target/release/webview-manager',
    ] : []),
    'dist/popup',
    'src/assets/icons',
    'app-update.yml'
  ],
  ...(platform === 'darwin' ? {
    extendInfo: {
      NSAppleEventsUsageDescription: 'This app needs to send Apple Events to Microsoft Word to read document content.',
      NSAppleScriptEnabled: true,
    },
  } : {}),
};

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
      const fs = require('fs');
      const path = require('path');

      // Copy canvas and its dependencies to the build
      const modulesToCopy = ['canvas', 'better-sqlite3'];
      for (const module of modulesToCopy) {
        const src = path.join(__dirname, 'node_modules', module);
        const dest = path.join(buildPath, 'node_modules', module);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true });
          console.log(`Copied ${module} to package`);
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
      [FuseV1Options.RunAsNode]: false,
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
