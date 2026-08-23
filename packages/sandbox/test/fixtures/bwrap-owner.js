// @ts-check

import '@endo/init';

import { makeBwrapDriver } from '../../src/drivers/bwrap.js';

const scratchHostPath = process.argv[2];
if (scratchHostPath === undefined) {
  throw new Error('expected scratch host path');
}

const driver = makeBwrapDriver({ env: {} });
const slice = await driver.prepareSlice(
  harden({
    rootfs: { kind: 'host-bind' },
    mounts: [],
    scratchHostPath,
    network: 'none',
    seccomp: 'default',
    env: {},
    limits: {},
  }),
);
const child = await driver.spawn(
  slice,
  [
    '/bin/sh',
    '-c',
    'printf ready; (trap "" TERM; while :; do sleep 60; done) & trap "" TERM; while :; do sleep 60; done',
  ],
  {},
);
const iterator = child.stdout?.[Symbol.asyncIterator]();
if (iterator === undefined) throw new Error('missing bwrap stdout');
const first = await iterator.next();
if (first.done || !new TextDecoder().decode(first.value).includes('ready')) {
  throw new Error('bwrap child did not become ready');
}
process.stdout.write(`${child.pid}\n`);
setInterval(() => undefined, 60_000);
