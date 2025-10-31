const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

// IMPORTANT: Popup uses production mode to prevent hot-reload issues
// During development:
// - Popup builds once before app starts (prestart script)
// - No automatic rebuilds to avoid MessageBridge instance replacement mid-request
// - To manually rebuild: npm run build:popup
// - To watch for changes: npm run build:popup:watch (use with caution)
module.exports = {
  mode: 'production',
  entry: './src/popup/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist/popup'),
    filename: 'bundle.js',
    clean: true,
  },
  target: 'web',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/popup/index.html',
      filename: 'index.html',
      inject: 'body',
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: './src/popup/bridge-preload.js',
          to: 'bridge-preload.js',
        },
      ],
    }),
  ],
  optimization: {
    minimize: true,
  },
  devtool: false,
};
