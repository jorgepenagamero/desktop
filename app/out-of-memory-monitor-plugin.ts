import * as webpack from 'webpack'
import * as Path from 'path'

const OutOfMemoryMonitor = function() {}

OutOfMemoryMonitor.prototype.apply = function(compiler: webpack.Compiler) {
  compiler.hooks.beforeRun.tap(
    'before-run',
    (compilation: webpack.compilation.Compilation) => {
      console.log(`beforeRun hook for process: ${process.pid}`)
      require('node-oom-heapdump')({
        path: Path.resolve(__dirname, 'webpack'),
      })
    }
  )
}

module.exports = OutOfMemoryMonitor
