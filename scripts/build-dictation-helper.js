#!/usr/bin/env node

// Builds the Swift on-device dictation helper (src/cobuilding/swift/dictation-mac).
// Mirrors scripts/build-cobuilding-rust.js: macOS-only, skipped elsewhere.
//
// Unlike the Rust helper this build is NOT fatal when it fails. Dictation is an
// optional convenience, and `swiftc` lives in the Xcode Command Line Tools,
// which a contributor may not have installed. Hard-failing here would block
// `npm start` for everyone over a feature they may not use — so a missing
// toolchain just means no helper binary, and `dictationService.ts` reports the
// feature unavailable and hides the mic button.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SOURCE_DIR = path.join(__dirname, '..', 'src', 'cobuilding', 'swift', 'dictation-mac');
const OUTPUT_DIR = path.join(SOURCE_DIR, 'build');
const OUTPUT_BIN = path.join(OUTPUT_DIR, 'dictation-mac');

function build({ optimize = true } = {}) {
  if (os.platform() !== 'darwin') {
    console.log(`Skipping dictation helper build on ${os.platform()}`);
    return false;
  }

  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
  } catch {
    console.warn('swiftc not found (Xcode Command Line Tools missing) — skipping dictation helper.');
    console.warn('Voice dictation will be unavailable. Install with: xcode-select --install');
    return false;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // -swift-version 5: the helper hands AVAudioEngine tap buffers across
  // concurrency domains, which Swift 6's strict checking rejects outright. The
  // hand-off is safe (one owner at a time, serialized by the Session actor),
  // but proving that to the 6 checker would mean restructuring working code.
  const args = ['swiftc', '-swift-version', '5'];
  if (optimize) args.push('-O');
  args.push(path.join(SOURCE_DIR, 'main.swift'), '-o', OUTPUT_BIN);

  try {
    console.log(`Building Swift dictation-mac (${optimize ? 'release' : 'debug'})...`);
    execFileSync('xcrun', args, { stdio: 'inherit' });
    console.log('Swift dictation-mac built successfully.');
    return true;
  } catch (error) {
    console.warn('Failed to build dictation helper:', error.message);
    console.warn('Voice dictation will be unavailable; the rest of the app is unaffected.');
    return false;
  }
}

module.exports = { build, OUTPUT_BIN };

if (require.main === module) {
  // Exit 0 even on failure — see the note above about not blocking the build.
  build({ optimize: !process.argv.includes('--debug') });
}
