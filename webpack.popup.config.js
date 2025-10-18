const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

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
  ],
  optimization: {
    minimize: true,
  },
  devtool: false,
};
