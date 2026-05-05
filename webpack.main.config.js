const webpack = require('webpack');

module.exports = {
  entry: './src/main.ts',
  module: {
    rules: require('./webpack.rules'),
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    fallback: {
      fs: false,
      path: false,
      crypto: false,
    },
  },
  externals: [
    {
      'tesseract.js': 'commonjs2 tesseract.js',
      'canvas': 'commonjs2 canvas',
      'better-sqlite3': 'commonjs2 better-sqlite3',
      '@anthropic-ai/claude-agent-sdk': 'commonjs2 @anthropic-ai/claude-agent-sdk',
      'pdf-parse': 'commonjs2 pdf-parse',
      'onnxruntime-node': 'commonjs2 onnxruntime-node',
      '@googleapis/calendar': 'commonjs2 @googleapis/calendar',
      'google-auth-library': 'commonjs2 google-auth-library',
      // gaxios → node-fetch → data-uri-to-buffer chain. plugin-webpack's
      // transitive prune walker doesn't reach data-uri-to-buffer through the
      // google-auth-library external (probably because it lives in nested
      // node_modules), so listing each one explicitly forces them to be
      // copied into the packaged .app.
      'gaxios': 'commonjs2 gaxios',
      'node-fetch': 'commonjs2 node-fetch',
      'data-uri-to-buffer': 'commonjs2 data-uri-to-buffer',
    },
    // Mark all .node files as external (native modules)
    function ({ request }, callback) {
      if (/\.node$/.test(request)) {
        return callback(null, 'commonjs2 ' + request);
      }
      callback();
    },
  ],
  plugins: [
    ...require('./webpack.plugins'),
    // Inject an early uncaught-exception handler for smoke tests.
    // This runs before any require() in the bundle, so it catches native
    // module load failures before Electron shows a blocking error dialog.
    new webpack.BannerPlugin({
      banner: [
        'if (process.argv.includes("--smoke-test")) {',
        '  process.on("uncaughtException", function(err) {',
        '    process.stderr.write("[SMOKE TEST] Fatal: " + err.stack + "\\n");',
        '    process.exit(1);',
        '  });',
        '}',
      ].join('\n'),
      raw: true,
    }),
    // Bake build-time credentials into the main bundle so packaged production
    // builds don't depend on the user's shell environment. Set GOOGLE_CLIENT_ID
    // and GOOGLE_CLIENT_SECRET before running `npm run make` (e.g. in CI:
    // `GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run make`). When unset
    // at build time, the bundle ships without credentials and the Settings UI
    // surfaces a "not configured" message — the production build is still
    // valid for users who don't enable Google Docs integration.
    (() => {
      const hasGoogleClientId = !!process.env.GOOGLE_CLIENT_ID;
      const hasGoogleClientSecret = !!process.env.GOOGLE_CLIENT_SECRET;
      // Single log line at the start of the main build so CI logs make it
      // obvious whether the secrets were piped through. No values printed.
      console.log(
        `[webpack.main] Google Docs OAuth credentials: GOOGLE_CLIENT_ID=${hasGoogleClientId ? 'set' : 'UNSET'}, GOOGLE_CLIENT_SECRET=${hasGoogleClientSecret ? 'set' : 'UNSET'}` +
          (hasGoogleClientId !== hasGoogleClientSecret
            ? ' — WARNING: only one of the two is set, OAuth will fail at runtime'
            : ''),
      );
      return new webpack.DefinePlugin({
        'process.env.GOOGLE_CLIENT_ID': JSON.stringify(process.env.GOOGLE_CLIENT_ID || ''),
        'process.env.GOOGLE_CLIENT_SECRET': JSON.stringify(process.env.GOOGLE_CLIENT_SECRET || ''),
      });
    })(),
  ],
};
