module.exports = [
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|\.webpack|src[\\/]cobuilding[\\/]mini-apps)/,
    use: {
      loader: 'ts-loader',
      options: {
        transpileOnly: true,
      },
    },
  },
];
