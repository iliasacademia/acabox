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
  console.log('Building Rust file-monitor-mac (debug)...');
  execSync('cargo build', {
    cwd: path.join(__dirname, '..', 'src', 'cobuilding', 'rust', 'file-monitor-mac'),
    stdio: 'inherit',
    env: cargoEnv,
  });
  console.log('Rust file-monitor-mac built successfully.');
} catch (error) {
  console.error('Failed to build Rust file-monitor-mac:', error.message);
  process.exit(1);
}

// Build the agent server bundle (runs inside the container)
try {
  console.log('Building agent-server bundle...');
  execSync('npx webpack --config webpack.agent-server.config.js', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
  console.log('Agent-server bundle built successfully.');
} catch (error) {
  console.error('Failed to build agent-server bundle:', error.message);
  process.exit(1);
}
