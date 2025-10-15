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
  externals: {
    'tesseract.js': 'commonjs2 tesseract.js',
    '@cherrystudio/mac-system-ocr': 'commonjs2 @cherrystudio/mac-system-ocr',
  },
  plugins: require('./webpack.plugins'),
};
