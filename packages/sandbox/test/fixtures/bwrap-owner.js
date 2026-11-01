// @ts-check

import '@endo/init';

import { makeBwrapDriver } from '../../src/drivers/bwrap.js';
import { SHARED_UID_LIMITS } from './shared-uid-limits.js';

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
    // This fixture tests parent death, not the process cap.
    limits: SHARED_UID_LIMITS,
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
// A pipe may deliver the marker split across reads, or after an empty
// read, so accumulate until it appears instead of trusting one chunk.
const decoder = new TextDecoder();
let output = '';
for (;;) {
  // eslint-disable-next-line no-await-in-loop, @jessie.js/safe-await-separator
  const next = await iterator.next();
  if (next.done) break;
  output += decoder.decode(next.value, { stream: true });
  if (output.includes('ready')) break;
}
if (!output.includes('ready')) {
  // Surface why the slice died before announcing itself (bwrap writes
  // namespace and mount failures to stderr) rather than a bare timeout.
  const stderrDecoder = new TextDecoder();
  let stderr = '';
  for await (const chunk of child.stderr ?? []) {
    stderr += stderrDecoder.decode(chunk, { stream: true });
  }
  const { code, signal } = await child.wait();
  throw new Error(
    `bwrap child did not become ready (exit ${code}, signal ${signal}); stdout ${JSON.stringify(output)}; stderr ${JSON.stringify(stderr)}`,
  );
}
process.stdout.write(`${child.pid}\n`);
setInterval(() => undefined, 60_000);
