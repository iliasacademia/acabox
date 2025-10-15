const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
  }),
  new CopyWebpackPlugin({
    patterns: [
      {
        from: 'src/overlay.html',
        to: 'overlay.html',
      },
      {
        from: 'src/applescripts',
        to: 'applescripts',
      },
    ],
  }),
];
