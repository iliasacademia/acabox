#!/usr/bin/env node

/**
 * Validate that all runtime dependencies of native modules are present
 * in node_modules with valid entry points. Run in CI and locally via:
 *   npm run check:native-deps
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');

// Must match the roots in forge.config.js
const nativeModuleRoots = ['canvas', 'better-sqlite3'];

const installTimeOnly = new Set([
  'prebuild-install', 'node-addon-api', 'node-gyp', 'node-gyp-build',
]);

function resolveRuntimeDeps(roots) {
  const resolved = new Set();
  const queue = [...roots];

  while (queue.length > 0) {
    const mod = queue.shift();
    if (resolved.has(mod) || installTimeOnly.has(mod)) continue;

    const pkgPath = path.join(NODE_MODULES, mod, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      console.error(`MISSING: ${mod} — not found in node_modules`);
      process.exitCode = 1;
      continue;
    }

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

const deps = resolveRuntimeDeps(nativeModuleRoots);

let ok = true;
for (const mod of deps) {
  const modDir = path.join(NODE_MODULES, mod);
  const pkgPath = path.join(modDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    console.error(`FAIL: ${mod} — missing from node_modules`);
    ok = false;
    continue;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const main = pkg.main || 'index.js';
  const entryPoint = path.join(modDir, main);

  // Check that the main entry point resolves (file or directory with index.js)
  if (!fs.existsSync(entryPoint) && !fs.existsSync(entryPoint + '.js') && !fs.existsSync(path.join(entryPoint, 'index.js'))) {
    console.error(`FAIL: ${mod} — entry point "${main}" not found`);
    ok = false;
    continue;
  }

  console.log(`  OK: ${mod}`);
}

if (!ok) {
  console.error('\nNative dependency check failed.');
  process.exit(1);
}

console.log(`\nAll ${deps.length} native runtime dependencies verified: ${deps.join(', ')}`);
