import { build } from 'esbuild'

// The Node floor the README advertises. esbuild fails the build on syntax it
// cannot lower to this target, so the claim is gated in CI whatever Node the
// runner carries.
const NODE_TARGET = 'node22'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: NODE_TARGET,
})
