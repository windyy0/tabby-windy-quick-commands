const path = require('path')

module.exports = (_environment, argv = {}) => {
  const production = argv.mode === 'production'

  return {
    target: 'node',
    entry: 'src/index.ts',
    devtool: production ? false : 'source-map',
    context: __dirname,
    mode: production ? 'production' : 'development',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'index.js',
      pathinfo: !production,
      libraryTarget: 'umd',
      devtoolModuleFilenameTemplate: 'webpack-tabby-quick-commands:///[resource-path]',
    },
    resolve: {
      modules: ['.', 'src', 'node_modules'].map(x => path.join(__dirname, x)),
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: 'ts-loader',
          options: {
            configFile: path.resolve(__dirname, 'tsconfig.json'),
          },
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    externals: [
      'fs',
      'ngx-toastr',
      /^rxjs/,
      /^@angular/,
      /^@ng-bootstrap/,
      /^tabby-/,
    ],
  }
}
