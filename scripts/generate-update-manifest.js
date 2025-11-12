#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Get arguments
const args = process.argv.slice(2);
const version = args[0];
const channel = args[1] || 'stable';
const arch = args[2] || 'arm64';
const outputDir = args[3] || `out/make/zip/darwin/${arch}`;

if (!version) {
  console.error('Usage: node generate-update-manifest.js <version> <channel> [arch] [outputDir]');
  process.exit(1);
}

// Find the .zip file
const zipFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.zip'));
if (zipFiles.length === 0) {
  console.error(`No .zip file found in ${outputDir}`);
  process.exit(1);
}

const zipFile = zipFiles[0];
const zipPath = path.join(outputDir, zipFile);

console.log(`Generating manifest for ${zipFile}...`);

// Calculate SHA512
const fileBuffer = fs.readFileSync(zipPath);
const hash = crypto.createHash('sha512');
hash.update(fileBuffer);
const sha512 = hash.digest('base64');

// Get file size
const stats = fs.statSync(zipPath);
const size = stats.size;

// Get release date (current time)
const releaseDate = new Date().toISOString();

// Generate manifest
const manifest = {
  version: version,
  releaseDate: releaseDate,
  files: [
    {
      url: zipFile,
      sha512: sha512,
      size: size
    }
  ],
  path: zipFile,
  sha512: sha512,
  releaseNotes: `Release version ${version}`
};

// Convert to YAML format
const yaml = `version: ${manifest.version}
releaseDate: '${manifest.releaseDate}'
files:
  - url: ${manifest.files[0].url}
    sha512: ${manifest.files[0].sha512}
    size: ${manifest.files[0].size}
path: ${manifest.path}
sha512: ${manifest.sha512}
releaseNotes: ${manifest.releaseNotes}
`;

// Write manifest file
const manifestPath = path.join(outputDir, `${channel}-mac.yml`);
fs.writeFileSync(manifestPath, yaml, 'utf8');

console.log(`Manifest generated at ${manifestPath}`);
console.log(`Channel: ${channel}`);
console.log(`Version: ${version}`);
console.log(`File: ${zipFile}`);
console.log(`Size: ${size} bytes`);
console.log(`SHA512: ${sha512.substring(0, 32)}...`);
