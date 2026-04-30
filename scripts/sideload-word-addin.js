#!/usr/bin/env node
/**
 * Sideload the Academia Office add-in for Word, PowerPoint, and Excel on macOS.
 * Uses the same paths as the desktop app's IPC handler.
 *
 * Usage:
 *   node scripts/sideload-word-addin.js              # sideload
 *   node scripts/sideload-word-addin.js --remove      # remove
 *   node scripts/sideload-word-addin.js --status      # check status
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ADDIN_ID = 'e56ffae3-be6a-463a-a4a2-9ec965f8d2d7';
const MANIFEST_NAME = `${ADDIN_ID}.manifest.xml`;

const WEF_DIRS = {
  Word: path.join(os.homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents/wef'),
  PowerPoint: path.join(os.homedir(), 'Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef'),
  Excel: path.join(os.homedir(), 'Library/Containers/com.microsoft.Excel/Data/Documents/wef'),
};

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MANIFEST_SRC = path.join(PROJECT_ROOT, 'ms_office_addin', 'manifest-local.xml');

const action = process.argv[2];

if (action === '--status') {
  console.log('\n=== Office Add-in Status ===\n');
  for (const [name, wefDir] of Object.entries(WEF_DIRS)) {
    const installed = fs.existsSync(path.join(wefDir, MANIFEST_NAME));
    console.log(`  ${installed ? '✓' : '✗'} ${name}: ${installed ? 'Installed' : 'Not installed'}`);
  }
  console.log('');
  process.exit(0);
}

if (action === '--remove') {
  console.log('\n=== Removing Office Add-in ===\n');
  for (const [name, wefDir] of Object.entries(WEF_DIRS)) {
    const manifestPath = path.join(wefDir, MANIFEST_NAME);
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
      console.log(`  ✓ ${name}: Removed`);
    } else {
      console.log(`  - ${name}: Not installed`);
    }
  }
  console.log('\nRestart Office apps to take effect.\n');
  process.exit(0);
}

// Default: sideload
if (!fs.existsSync(MANIFEST_SRC)) {
  console.error(`ERROR: manifest not found at ${MANIFEST_SRC}`);
  process.exit(1);
}

console.log('\n=== Sideloading Office Add-in ===\n');
for (const [name, wefDir] of Object.entries(WEF_DIRS)) {
  fs.mkdirSync(wefDir, { recursive: true });
  fs.copyFileSync(MANIFEST_SRC, path.join(wefDir, MANIFEST_NAME));
  console.log(`  ✓ ${name}: ${wefDir}`);
}

console.log('\n=== Done! ===\n');
console.log('Next steps:');
console.log('  1. Make sure the cobuild desktop app is running');
console.log('  2. Quit Word / PowerPoint / Excel completely (Cmd+Q)');
console.log('  3. Reopen the app and open a document');
console.log('  4. Look for "Academia Test" group in the Home ribbon tab');
console.log('');
