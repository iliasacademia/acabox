const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const NativeWatchPlugin = require('./webpack.native-watch.plugin');
const webpack = require('webpack');
const { validateCloudFrontDomain } = require('./src/utils/validateCloudFrontDomain');

// Validate CLOUDFRONT_DOMAIN at build time
const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;

if (!cloudFrontDomain) {
  throw new Error(
    '\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '  ⚠️  SECURITY ERROR: CLOUDFRONT_DOMAIN not configured\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '\n' +
    '  The CLOUDFRONT_DOMAIN environment variable must be set for builds.\n' +
    '  This is required for secure auto-updater configuration.\n' +
    '\n' +
    '  Expected format: <distribution-id>.cloudfront.net\n' +
    '  Example: d111111abcdef8.cloudfront.net\n' +
    '\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  );
}

if (!validateCloudFrontDomain(cloudFrontDomain)) {
  throw new Error(
    '\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '  🚨 SECURITY ERROR: Invalid CLOUDFRONT_DOMAIN\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '\n' +
    `  Provided value: "${cloudFrontDomain}"\n` +
    '\n' +
    '  Security validation failed. CLOUDFRONT_DOMAIN must:\n' +
    '    ✓ Be a valid CloudFront domain (*.cloudfront.net)\n' +
    '    ✓ Contain only alphanumeric characters, dots, and hyphens\n' +
    '    ✓ Not contain protocols (http://, https://)\n' +
    '    ✓ Not contain paths or query parameters\n' +
    '\n' +
    '  Valid example: d111111abcdef8.cloudfront.net\n' +
    '  Invalid examples:\n' +
    '    ✗ evil.com\n' +
    '    ✗ https://d111111abcdef8.cloudfront.net\n' +
    '    ✗ d111111abcdef8.cloudfront.net/path\n' +
    '\n' +
    '  This validation prevents malicious update server redirects.\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  );
}

console.log(`✓ Build-time security check passed: CLOUDFRONT_DOMAIN="${cloudFrontDomain}"`);

module.exports = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
  }),
  new webpack.DefinePlugin({
    'process.env.CLOUDFRONT_DOMAIN': JSON.stringify(process.env.CLOUDFRONT_DOMAIN || ''),
  }),
  new CopyWebpackPlugin({
    patterns: [
      {
        from: 'src/applescripts',
        to: 'applescripts',
      },
      {
        from: 'src/native/build/Release/word_accessibility.node',
        to: 'native/build/Release/word_accessibility.node',
        noErrorOnMissing: true,
      },
      {
        from: 'dist/popup',
        to: 'popup',
        noErrorOnMissing: true,
      },
      {
        from: 'src/assets/icons',
        to: 'assets/icons',
      },
    ],
  }),
  new NativeWatchPlugin({
    debounceDelay: 300, // Wait 300ms after last change before rebuilding
  }),
];
