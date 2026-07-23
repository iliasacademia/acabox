const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function isPortInUse(port) {
  try {
    if (os.platform() === 'win32') {
      execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { stdio: 'ignore' });
    } else {
      execSync(`lsof -i :${port} -sTCP:LISTEN`, { stdio: 'ignore' });
    }
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
const nativeModuleRoots = ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'];

const installTimeOnly = new Set([
  'prebuild-install', 'node-addon-api', 'node-gyp', 'node-gyp-build',
]);

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
    for (const depField of ['dependencies', 'optionalDependencies']) {
      if (pkg[depField]) {
        for (const dep of Object.keys(pkg[depField])) {
          if (!resolved.has(dep) && !installTimeOnly.has(dep)) {
            queue.push(dep);
          }
        }
      }
    }
  }

  return [...resolved];
}

const codeSignIdentity = process.env.APPLE_IDENTITY || undefined;
const platform = os.platform();

const packagerConfig = {
  name: 'Acabox',
  icon: './src/assets/icons/dock-icon',
  appBundleId: 'com.electron.acabox',
  derefSymlinks: true,
  prune: false,
  // The scheme the runtime actually handles (app.setAsDefaultProtocolClient +
  // the open-url filter in src/cobuilding/main/index.ts). It is constructed by
  // the academia.edu QR-auth flow, so it cannot be renamed client-side; note it
  // is also registered by the original Academia Coscientist app — whichever app
  // launched most recently receives the callbacks.
  protocols: [
    {
      name: 'Acabox',
      schemes: ['cobuilding-agent'],
    },
  ],
  asar: {
    unpack: '{**/node_modules/better-sqlite3/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*}',
  },
  extraResource: [
    'dist/agent-server.js',
    'src/cobuilding/prebuilt-apps',
    'src/assets/icons',
    'app-update.yml',
    'src/cobuilding/skills',
    'src/cobuilding/CLAUDE.md',
    'src/cobuilding/settings.json',
    'src/cobuilding/hooks',
    ...(platform === 'darwin' && fs.existsSync('src/cobuilding/rust/file-monitor-mac/target/release/file-monitor-mac')
      ? ['src/cobuilding/rust/file-monitor-mac/target/release/file-monitor-mac']
      : []),
  ],
  ...(platform === 'darwin' ? {
    extendInfo: {
      NSDesktopFolderUsageDescription: 'Acabox needs access to your Desktop to manage workspace files.',
      NSDocumentsFolderUsageDescription: 'Acabox needs access to your Documents to manage workspace files.',
      NSDownloadsFolderUsageDescription: 'Acabox needs access to your Downloads to manage workspace files.',
    },
  } : {}),
};

if (codeSignIdentity) {
  packagerConfig.osxSign = {
    identity: codeSignIdentity,
    hardenedRuntime: true,
    entitlements: 'entitlements.plist',
    'entitlements-inherit': 'entitlements.plist',
  };

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
    packageAfterCopy: async (_config, buildPath) => {
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
        name: 'Acabox',
        authors: 'Academia.edu',
        description: 'Acabox',
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
        devContentSecurityPolicy: "default-src 'self' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: local-file:; frame-src local-file: http://localhost:* http://127.0.0.1:*; connect-src 'self' ws: http://localhost:*;",
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
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
};
