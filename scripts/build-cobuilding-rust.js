#!/usr/bin/env node

const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const platform = os.platform();

if (platform !== 'darwin') {
  console.log(`Skipping cobuilding Rust build on ${platform}`);
  process.exit(0);
}

const cargoEnv = Object.assign({}, process.env, {
  PATH: path.join(os.homedir(), '.cargo', 'bin') + ':' + process.env.PATH,
});

try {
  console.log('Building Rust file-monitor-mac...');
  execSync('cargo build --release', {
    cwd: path.join(__dirname, '..', 'src', 'cobuilding', 'rust', 'file-monitor-mac'),
    stdio: 'inherit',
    env: cargoEnv,
  });
  console.log('Rust file-monitor-mac built successfully.');
} catch (error) {
  console.error('Failed to build Rust file-monitor-mac:', error.message);
  process.exit(1);
}
