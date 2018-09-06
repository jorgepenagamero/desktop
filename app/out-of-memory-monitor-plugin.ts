import * as webpack from 'webpack'
import * as Path from 'path'

let OutOfMemoryMonitor = function() {}

OutOfMemoryMonitor.prototype.apply = function(compiler: webpack.Compiler) {
  compiler.hooks.beforeRun.tap(
    'before-run',
    (compilation: webpack.compilation.Compilation) => {
      require('node-oom-heapdump')({
        path: Path.resolve(__dirname, 'webpack'),
      })
    }
  )
}

module.exports = OutOfMemoryMonitor
