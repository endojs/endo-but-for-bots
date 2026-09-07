import '@endo/init';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';

const readPowers = makeReadPowers({ fs, url, crypto, path });
const root = new URL('../', import.meta.url);
const dist = new URL('dist-ironhorse/', root);
fs.mkdirSync(dist, { recursive: true });
const ses = await makeBundle(readPowers, import.meta.resolve('ses'));
const polyfills = fs
  .readFileSync(new URL('../../rust/endo/xsnap/src/polyfills.js', root), 'utf8')
  .split('// -- assert polyfill --')[0];
fs.writeFileSync(
  new URL('boot.js', dist),
  `
${polyfills}
delete globalThis.harden;
// Ironhorse advertises Iterator before its lazy helper objects are implemented.
// Use the pre-helper iterator profile, including the shared prototype, rather
// than leave half of the proposal reachable through iterator instances.
for (const key of Reflect.ownKeys(globalThis.Iterator.prototype)) {
  if (key !== Symbol.iterator) delete globalThis.Iterator.prototype[key];
}
globalThis.Iterator = undefined;
// The start realm has no host console. SES expects a console object even when
// reporting is disabled; diagnostics do not confer an external I/O capability.
globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} };
${ses}
lockdown({ errorTaming: 'safe', reporting: 'none' });
(() => {
  let outbound = [];
  globalThis.thixotropeSend = json => outbound.push(JSON.parse(json));
  globalThis.thixotropeTakeOutbound = () => {
    const result = outbound;
    outbound = [];
    return result;
  };
})();
`,
);
const excluded = new Set(['ses', '@endo/init', '@endo/lockdown']);
const peer = await makeBundle(
  readPowers,
  new URL('src/worker-peer-xs.js', root).href,
  {
    packageDependenciesHook: ({ dependencies }) =>
      new Set([...dependencies].filter(name => !excluded.has(name))),
  },
);
fs.writeFileSync(new URL('worker-peer.js', dist), peer);
console.log(`Built Ironhorse worker in ${url.fileURLToPath(dist)}`);
