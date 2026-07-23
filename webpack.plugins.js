const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
const { sentryWebpackPlugin } = require('@sentry/webpack-plugin');
const { validateCloudFrontDomain } = require('./src/utils/validateCloudFrontDomain');

// Validate CLOUDFRONT_DOMAIN at build time (skip in development)
const isDevelopment = process.env.NODE_ENV === 'development';
const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;

if (!isDevelopment) {
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
} else {
  console.log('⚠️  Development mode: Skipping CLOUDFRONT_DOMAIN validation');
}

module.exports = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
  }),
  new webpack.DefinePlugin({
    'process.env.CLOUDFRONT_DOMAIN': JSON.stringify(process.env.CLOUDFRONT_DOMAIN || ''),
    'process.env.DATADOG_CLIENT_TOKEN': JSON.stringify(process.env.DATADOG_CLIENT_TOKEN || ''),
    'process.env.DATADOG_SITE': JSON.stringify(process.env.DATADOG_SITE || 'datadoghq.com'),
    'process.env.DATADOG_APPLICATION_ID': JSON.stringify(process.env.DATADOG_APPLICATION_ID || ''),
    'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN || ''),
    'process.env.ONBOARDING_V2_ENABLED': JSON.stringify(process.env.ONBOARDING_V2_ENABLED || 'false'),
    'process.env.FULLSTORY_FORCE_RECORDING': JSON.stringify(process.env.FULLSTORY_FORCE_RECORDING || 'false'),
    'process.env.ENTRY_POINT': JSON.stringify(process.env.ENTRY_POINT || ''),
    'process.env.BROWSER_EXTENSION_VERSION': JSON.stringify(require('./package.json').browserExtensionVersion || ''),
  }),
  new CopyWebpackPlugin({
    patterns: [
      {
        from: 'src/assets/icons',
        to: 'assets/icons',
      },
    ],
  }),
  // Sentry source-map upload. Runs once per webpack compilation (main + renderer);
  // each invocation uploads the maps from its own output directory, tagged with
  // the same `release` value the runtime Sentry SDK uses (package.json version).
  //
  // No-op when SENTRY_AUTH_TOKEN is unset (local dev, CI without the secret
  // configured) so the plugin doesn't fail the build.
  sentryWebpackPlugin({
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: 'acabox@' + require('./package.json').version },
    disable:
      !process.env.SENTRY_AUTH_TOKEN ||
      !process.env.SENTRY_ORG ||
      !process.env.SENTRY_PROJECT,
    telemetry: false,
    // Silent unless we're actually uploading (otherwise dev runs print noise).
    silent: !process.env.SENTRY_AUTH_TOKEN,
  }),
];
