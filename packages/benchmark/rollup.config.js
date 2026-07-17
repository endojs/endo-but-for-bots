import { nodeResolve } from '@rollup/plugin-node-resolve';

/** @type {import('rollup').RollupOptions} */
const config = {
  input: 'test/index.test.js',
  output: {
    file: 'dist/bundle.js',
    format: 'iife',
    name: 'bundle',
    sourcemap: false,
  },
  plugins: [nodeResolve()],
};

export default config;
