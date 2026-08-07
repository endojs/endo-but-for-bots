// @ts-check

import '@endo/init';

import { makePodmanDriver } from '../../src/drivers/podman.js';

const ownerId = process.argv[2];
const ref = process.argv[3];
const scratchHostPath = process.argv[4];
if (ownerId === undefined || ref === undefined || scratchHostPath === undefined) {
  throw new Error('expected owner id, OCI ref, and scratch host path');
}

const driver = makePodmanDriver({ env: {}, ownerId });
const probe = await driver.probe();
if (!probe.available) throw new Error(probe.reason ?? 'podman unavailable');
const slice = await driver.prepareSlice(
  harden({
    rootfs: { kind: 'oci', ref },
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
    'printf ready; trap "" TERM; while :; do sleep 60; done',
  ],
  {},
);
const iterator = child.stdout?.[Symbol.asyncIterator]();
if (iterator === undefined) throw new Error('missing podman stdout');
const first = await iterator.next();
if (first.done || !new TextDecoder().decode(first.value).includes('ready')) {
  throw new Error('podman child did not become ready');
}
process.stdout.write('ready\n');
setInterval(() => undefined, 60_000);
