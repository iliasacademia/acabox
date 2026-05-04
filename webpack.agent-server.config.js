const path = require('path');

module.exports = {
  entry: './src/cobuilding/agent-server/index.ts',
  target: 'node',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'agent-server.js',
  },
  resolve: {
    extensions: ['.ts', '.js', '.mjs'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: { transpileOnly: true },
        },
      },
    ],
  },
  // Bundle everything — the container has no node_modules
  externals: {},
  optimization: {
    minimize: false, // Keep readable for debugging
  },
};
