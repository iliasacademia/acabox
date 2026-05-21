const webpack = require('webpack');

module.exports = {
  entry: './src/main.ts',
  ...(process.env.NODE_ENV === 'production' ? { devtool: 'source-map' } : {}),
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
      'better-sqlite3': 'commonjs2 better-sqlite3',
      '@anthropic-ai/claude-agent-sdk': 'commonjs2 @anthropic-ai/claude-agent-sdk',
      'esbuild': 'commonjs2 esbuild',
    },
    function ({ request }, callback) {
      if (/\.node$/.test(request)) {
        return callback(null, 'commonjs2 ' + request);
      }
      callback();
    },
  ],
  plugins: [
    ...require('./webpack.plugins'),
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
