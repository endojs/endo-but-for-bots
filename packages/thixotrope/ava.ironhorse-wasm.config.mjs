import { fileURLToPath } from 'node:url';

import base from '../../ava-endo-lockdown.config.mjs';
import ironhorse from './ava.ironhorse.config.mjs';

// This explicit lane runs the host's Ironhorse suite, unmodified, against the
// WebAssembly engine, then the tests only that engine needs. It requires the
// staged engine (`python3 rust/thixotrope-ironhorse-wasm/build.py --stage`),
// the boot bundles and the native worker, which some tests compare against.
// `THIXOTROPE_IRONHORSE_WASM_WORKER` overrides the staged launcher's path,
// and `THIXOTROPE_IRONHORSE_NATIVE_WORKER` the native worker's.
const wasmWorker =
  process.env.THIXOTROPE_IRONHORSE_WASM_WORKER ||
  fileURLToPath(
    new URL(
      '../../target/thixotrope-ironhorse-wasm/thixotrope-ironhorse-wasm-worker',
      import.meta.url,
    ),
  );

export default {
  ...base,
  files: [
    ...ironhorse.files,
    'test/ironhorse-wasm/runtime-identity.js',
    'test/ironhorse-wasm/shell.js',
    'test/ironhorse-wasm/shell-failures.js',
    'test/ironhorse-wasm/engine-mismatch.js',
    'test/ironhorse-wasm/node-version.js',
  ],
  // Some of the engine's own tests read SQLite files with node:sqlite.
  nodeArguments: [
    ...base.nodeArguments,
    '--disable-warning=ExperimentalWarning',
  ],
  // The host's suite reads the worker from THIXOTROPE_IRONHORSE_WORKER.
  environmentVariables: {
    THIXOTROPE_IRONHORSE_WORKER: wasmWorker,
    THIXOTROPE_IRONHORSE_WASM_WORKER: wasmWorker,
  },
  timeout: '3m',
  concurrency: 1,
};
