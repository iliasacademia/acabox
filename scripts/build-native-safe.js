#!/usr/bin/env node

const os = require('os');
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
} else {
  console.log(`Skipping native module build on ${platform}`);
  console.log('Word integration features will be disabled on this platform.');
}
