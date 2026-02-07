#!/usr/bin/env node

const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const platform = os.platform();

if (platform === 'darwin') {
  console.log('Building native modules for macOS...');
  try {
    execSync('cd src/native && npx node-gyp rebuild', { stdio: 'inherit' });
    console.log('Native modules built successfully.');
  } catch (error) {
    console.error('Failed to build native modules:', error.message);
    process.exit(1);
  }
  try {
    console.log('Building Rust window-monitor...');
    const cargoEnv = Object.assign({}, process.env, {
      PATH: path.join(os.homedir(), '.cargo', 'bin') + ':' + process.env.PATH,
    });
    execSync('cargo build --release', {
      cwd: path.join(__dirname, '..', 'window-monitor', 'rust'),
      stdio: 'inherit',
      env: cargoEnv,
    });
    console.log('Rust window-monitor built successfully.');
  } catch (error) {
    console.error('Failed to build Rust window-monitor:', error.message);
    process.exit(1);
  }
} else {
  console.log(`Skipping native module build on ${platform}`);
  console.log('Word integration features will be disabled on this platform.');
}
