const rules = require('./webpack.rules');
const plugins = require('./webpack.plugins');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const isDevelopment = process.env.NODE_ENV === 'development';

rules.push({
  test: /\.css$/,
  use: [
    // Use style-loader in development for hot reloading
    // Use MiniCssExtractPlugin in production to extract CSS into separate files
    isDevelopment ? { loader: 'style-loader' } : MiniCssExtractPlugin.loader,
    { loader: 'css-loader' }
  ],
});

// Add MiniCssExtractPlugin to plugins array for production builds
if (!isDevelopment) {
  plugins.push(
    new MiniCssExtractPlugin({
      filename: '[name].[contenthash].css',
    })
  );
}

module.exports = {
  module: {
    rules,
  },
  plugins: plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
