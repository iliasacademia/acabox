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
  ],
};
