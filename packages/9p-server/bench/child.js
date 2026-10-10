// @ts-check
/* global process */
//
// Child process for `bench.js`: hosts a node-fs `Filesystem` behind a
// netstring CapTP connection on fds 3 (read) and 4 (write), the same pipe
// wiring the daemon uses for its workers
// (`packages/daemon/src/manager-node-powers.js`).
//
// BENCH_MODE=fs     serve `makeNodeFilesystem({ rootPath: BENCH_ROOT })`.
// BENCH_MODE=relay  fork a grandchild in `fs` mode and re-export its
//                   bootstrap, so the parent sees the filesystem through two
//                   hops — what a cross-worker call through the daemon costs.

import '@endo/init';

import { fork } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeNodeFilesystem } from '@endo/platform/fs/extended/node-fs.js';

// Workspace-relative on purpose; see bench.js.
/* eslint-disable import/no-relative-packages */
import { makeNetstringCapTP } from '../../daemon/src/connection.js';
import { makeNodeReader, makeNodeWriter } from '../../stream-node/index.js';
/* eslint-enable import/no-relative-packages */

const never = new Promise(() => {});

const mode = process.env.BENCH_MODE;
const rootPath = process.env.BENCH_ROOT;
if (!rootPath) throw new Error('BENCH_ROOT is required');

/** @type {unknown} */
let bootstrap;
if (mode === 'fs') {
  bootstrap = makeNodeFilesystem({ rootPath });
} else if (mode === 'relay') {
  const grandchild = fork(fileURLToPath(import.meta.url), [], {
    stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, BENCH_MODE: 'fs' },
  });
  const down = makeNetstringCapTP(
    'bench-down',
    makeNodeWriter(/** @type {any} */ (grandchild.stdio[3])),
    makeNodeReader(/** @type {any} */ (grandchild.stdio[4])),
    never,
    harden({}),
  );
  // A promise for a presence imported from the grandchild; exporting it on
  // the upward connection makes this process a relay, as the daemon is
  // between two workers.
  bootstrap = down.getBootstrap();
  process.on('exit', () => grandchild.kill());
} else {
  throw new Error(`unknown BENCH_MODE ${mode}`);
}

makeNetstringCapTP(
  'bench-up',
  makeNodeWriter(createWriteStream('', { fd: 4 })),
  makeNodeReader(createReadStream('', { fd: 3 })),
  never,
  bootstrap,
);

// The parent's death closes the IPC channel; do not outlive it.
process.on('disconnect', () => process.exit(0));
