const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');


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
    reviewButton: './src/popup/ReviewButton.tsx',
    reviewButtonV3: './src/popup/ReviewButtonV3.tsx',
    reviewStatusOverlay: './src/popup/ReviewStatusOverlay.tsx',
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
        use: ['style-loader', 'css-loader'],
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
    new HtmlWebpackPlugin({
      template: './src/popup/review-button.html',
      filename: 'reviewButton/index.html',
      chunks: ['reviewButton'],
      inject: false,
      scriptLoading: 'blocking',
    }),
    new HtmlWebpackPlugin({
      template: './src/popup/review-button-v3.html',
      filename: 'reviewButtonV3/index.html',
      chunks: ['reviewButtonV3'],
      inject: false,
      scriptLoading: 'blocking',
    }),
    new HtmlWebpackPlugin({
      template: './src/popup/review-status-overlay.html',
      filename: 'reviewStatusOverlay/index.html',
      chunks: ['reviewStatusOverlay'],
      inject: false,
      scriptLoading: 'blocking',
    }),
    new HtmlWebpackPlugin({
      template: './src/popup/debugging-red-border-container.html',
      filename: 'debuggingRedBorderContainer/index.html',
      chunks: [],
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/popup/vendor/fs.js', to: 'fs.js' },
      ],
    }),
  ],
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        exclude: /fs\.js$/,
      }),
    ],
  },
  devtool: false,
};
