const path = require('path')
const webpack = require('webpack')

module.exports = (_environment, argv = {}) => {
  const production = argv.mode === 'production'
  const devBuild = _environment?.channel === 'dev'
  const outputDirectory = devBuild ? 'dist-dev' : 'dist'

  return {
    target: 'node',
    entry: 'src/index.ts',
    devtool: production ? false : 'source-map',
    context: __dirname,
    mode: production ? 'production' : 'development',
    output: {
      path: path.resolve(__dirname, outputDirectory),
      clean: true,
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
        ...(devBuild ? [{
          test: /\.(ts|css)$/,
          include: path.resolve(__dirname, 'src'),
          enforce: 'pre',
          loader: path.resolve(__dirname, 'scripts/dev-namespace-loader.cjs'),
        }] : []),
        {
          test: /\.ts$/,
          loader: 'ts-loader',
          options: {
            configFile: path.resolve(__dirname, 'tsconfig.json'),
            compilerOptions: { declarationDir: path.resolve(__dirname, outputDirectory) },
          },
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [new webpack.DefinePlugin({ __WQC_DEV_BUILD__: JSON.stringify(devBuild) })],
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
