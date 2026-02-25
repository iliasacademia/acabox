const rules = require('./webpack.rules');
const plugins = require('./webpack.plugins');

// Always use style-loader to inline CSS as <style> tags in the DOM.
// This is required for FullStory session replay: Electron loads the renderer
// via file:// protocol, so FullStory cannot fetch external .css files during
// replay reconstruction. Inline styles are captured in the DOM snapshot.
// The traditional benefits of extracting CSS (browser caching, CDN delivery,
// parallel loading) don't apply to Electron's file:// protocol.
rules.push({
  test: /\.css$/,
  use: [
    { loader: 'style-loader' },
    { loader: 'css-loader' }
  ],
});

rules.push({
  test: /\.(png|jpg|jpeg|gif|svg)$/,
  type: 'asset/resource',
});

module.exports = {
  module: {
    rules,
  },
  plugins: plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
