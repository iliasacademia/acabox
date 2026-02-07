const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

// IMPORTANT: Popup uses production mode to prevent hot-reload issues
// During development:
// - Popup builds once before app starts (prestart script)
// - No automatic rebuilds to avoid MessageBridge instance replacement mid-request
// - To manually rebuild: npm run build:popup
// - To watch for changes: npm run build:popup:watch (use with caution)
module.exports = {
  mode: 'production',
  entry: {
    academiaNotificationsButtonV2: './src/popup/AcademiaNotificationsButtonV2.tsx',
    academiaNotificationsV2: './src/popup/AcademiaNotificationsPopupV2.tsx',
  },
  output: {
    path: path.resolve(__dirname, 'dist/popup'),
    filename: '[name]/bundle.js',
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
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      {
        test: /\.svg$/,
        type: 'asset/resource',
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/popup/academia-notifications-button-v2.html',
      filename: 'academiaNotificationsButtonV2/index.html',
      chunks: ['academiaNotificationsButtonV2'],
      inject: false, // Don't inject - we manually control script loading order
      scriptLoading: 'blocking',
    }),
    new HtmlWebpackPlugin({
      template: './src/popup/academia-notifications-v2.html',
      filename: 'academiaNotificationsV2/index.html',
      chunks: ['academiaNotificationsV2'],
      inject: false, // Don't inject - we manually control script loading order
      scriptLoading: 'blocking',
    }),
    new MiniCssExtractPlugin({
      filename: '[name]/styles.css', // Use predictable filename for manual HTML injection
    }),
  ],
  optimization: {
    minimize: true,
  },
  devtool: false,
};
