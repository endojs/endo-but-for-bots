// @ts-check
import process from 'node:process';
import { hostname } from 'node:os';
import { startProviderListenerWorker } from './provider-worker.js';

const expected = harden({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  NODE_VERSION: '22.19.0',
  YARN_VERSION: '1.22.22',
  HOME: '/home/node',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});
const observed = { ...process.env };
if (observed.HOSTNAME !== undefined) {
  if (observed.HOSTNAME !== hostname())
    throw Error('Provider worker hostname mismatch');
  delete observed.HOSTNAME;
}
if (observed.container !== undefined) {
  if (observed.container !== 'podman')
    throw Error('Provider worker runtime mismatch');
  delete observed.container;
}
if (
  Object.keys(observed).length !== Object.keys(expected).length ||
  Object.entries(expected).some(([key, value]) => observed[key] !== value)
) {
  throw Error('Provider worker environment rejected');
}
// stdout belongs exclusively to CapTP. Only fixed failure text reaches stderr.
startProviderListenerWorker({ input: process.stdin, output: process.stdout })
  .then(({ closed }) => closed)
  .catch(() => {
    process.stderr.write('Provider listener worker failed\n');
    process.exitCode = 1;
    process.stdin.destroy();
    process.stdout.destroy();
  });
