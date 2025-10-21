const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
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
];
