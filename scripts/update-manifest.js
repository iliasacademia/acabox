#!/usr/bin/env node

/**
 * Update Electron auto-updater manifest with CloudFront URLs
 *
 * This script safely modifies the YAML manifest file to replace local paths
 * with versioned CloudFront URLs. It uses environment variables to prevent
 * command injection vulnerabilities.
 *
 * Environment Variables Required:
 * - MANIFEST_FILE: Path to the manifest YAML file
 * - CLOUDFRONT_DOMAIN: CloudFront distribution domain
 * - CHANNEL: Release channel (stable, beta, etc.)
 * - VERSION: Version string for the release
 * - ARCH: CPU architecture (arm64, x64) - for macOS builds
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Read environment variables
const manifestFile = process.env.MANIFEST_FILE;
const cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN;
const channel = process.env.CHANNEL;
const version = process.env.VERSION;
const arch = process.env.ARCH;

// Validate required environment variables
if (!manifestFile || !cloudfrontDomain || !channel || !version || !arch) {
  console.error('Error: Missing required environment variables');
  console.error('Required: MANIFEST_FILE, CLOUDFRONT_DOMAIN, CHANNEL, VERSION, ARCH');
  process.exit(1);
}

// Check if manifest file exists
if (!fs.existsSync(manifestFile)) {
  console.error(`Error: Manifest file not found at ${manifestFile}`);
  process.exit(1);
}

try {
  // Read and parse YAML safely
  const fileContents = fs.readFileSync(manifestFile, 'utf8');
  const data = yaml.load(fileContents);

  // Validate manifest structure
  if (!data || typeof data !== 'object') {
    console.error('Error: Invalid manifest structure');
    process.exit(1);
  }

  if (!data.path) {
    console.error('Error: Manifest does not contain a "path" field');
    process.exit(1);
  }

  // Extract the original filename from the path
  const originalFilename = path.basename(data.path);

  // Create versioned URL with architecture: https://DOMAIN/CHANNEL/ARCH/VERSION/filename
  const newUrl = `https://${cloudfrontDomain}/${channel}/${arch}/${version}/${originalFilename}`;

  // Update the path field
  data.path = newUrl;

  // Update url field in files array if it exists
  if (data.files && Array.isArray(data.files)) {
    data.files.forEach(file => {
      if (file && typeof file === 'object' && file.url) {
        file.url = newUrl;
      }
    });
  }

  // Write back to file with proper YAML formatting
  const updatedYaml = yaml.dump(data, {
    lineWidth: -1,        // Don't wrap lines
    noRefs: true,         // Don't use references
    sortKeys: false,      // Preserve key order
    quotingType: '"',     // Use double quotes
    forceQuotes: false    // Only quote when necessary
  });

  fs.writeFileSync(manifestFile, updatedYaml, 'utf8');

  // Output success message
  console.log(`Updated manifest URLs to: ${newUrl}`);
  console.log('Updated manifest content:');
  console.log(updatedYaml);

  process.exit(0);
} catch (error) {
  console.error(`Error updating manifest: ${error.message}`);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
