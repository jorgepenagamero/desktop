#!/usr/bin/env ts-node

import * as Path from 'path'
import { spawnSync } from 'child_process'

const root = Path.dirname(__dirname)

require('node-oom-heapdump')({
  path: Path.resolve(__dirname, 'webpack'),
})

const configPath =
  process.env.NODE_ENV === 'production'
    ? 'app/webpack.production.ts'
    : 'app/webpack.development.ts'

const args = [
  '--inspect',
  './node_modules/parallel-webpack/bin/run.js',
  '--config',
  configPath,
]

spawnSync('node', args, {
  cwd: root,
  stdio: 'inherit',
})
