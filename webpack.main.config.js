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
    },
    // Mark all .node files as external (native modules)
    function ({ request }, callback) {
      if (/\.node$/.test(request)) {
        return callback(null, 'commonjs2 ' + request);
      }
      callback();
    },
  ],
  plugins: require('./webpack.plugins'),
};
