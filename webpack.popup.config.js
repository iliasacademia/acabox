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
  entry: {
    academiaNotifications: './src/popup/AcademiaNotificationsPopup.tsx',
    overallReview: './src/popup/OverallReviewPopup.tsx',
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
    ],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/popup/academia-notifications.html',
      filename: 'academiaNotifications/index.html',
      chunks: ['academiaNotifications'],
      inject: 'body',
    }),
    new HtmlWebpackPlugin({
      template: './src/popup/overall-review.html',
      filename: 'overallReview/index.html',
      chunks: ['overallReview'],
      inject: 'body',
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: './src/popup/bridge-preload.js',
          to: 'academiaNotifications/bridge-preload.js',
        },
        {
          from: './src/popup/bridge-preload.js',
          to: 'overallReview/bridge-preload.js',
        },
      ],
    }),
  ],
  optimization: {
    minimize: true,
  },
  devtool: false,
};
