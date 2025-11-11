const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const NativeWatchPlugin = require('./webpack.native-watch.plugin');
const webpack = require('webpack');

module.exports = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
  }),
  new webpack.DefinePlugin({
    'process.env.CLOUDFRONT_DOMAIN': JSON.stringify(process.env.CLOUDFRONT_DOMAIN || ''),
  }),
  new CopyWebpackPlugin({
    patterns: [
      {
        from: 'src/applescripts',
        to: 'applescripts',
      },
      {
        from: 'src/native/build/Release/word_accessibility.node',
        to: 'native/build/Release/word_accessibility.node',
        noErrorOnMissing: true,
      },
      {
        from: 'dist/popup',
        to: 'popup',
        noErrorOnMissing: true,
      },
      {
        from: 'src/assets/icons',
        to: 'assets/icons',
      },
    ],
  }),
  new NativeWatchPlugin({
    debounceDelay: 300, // Wait 300ms after last change before rebuilding
  }),
];
