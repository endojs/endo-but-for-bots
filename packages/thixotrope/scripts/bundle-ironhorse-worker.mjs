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
// The Ironhorse repairs the shim needs, shared with `@endo/test262-runner`'s
// `ses-xs-parity` prelude so the corpus measures this environment rather than a
// look-alike. See `@endo/ironhorse-prelude` for what each repair is for.
//
// Terminated with an explicit `;` where it is interpolated below. A
// compartment-mapper bundle ends `])()` with no terminator and the `ses` bundle
// begins `(functors => ...`, so without one the two concatenate into a CALL --
// `])()(functors => ...)` -- and the boot dies with `call: not a function`.
// `@endo/test262-runner`'s `scripts/generate-preludes.js` appends the same
// terminator for the same reason.
const prologue = await makeBundle(
  readPowers,
  import.meta.resolve('@endo/ironhorse-prelude'),
);
const polyfills = fs
  .readFileSync(new URL('../../rust/endo/xsnap/src/polyfills.js', root), 'utf8')
  .split('// -- assert polyfill --')[0];
fs.writeFileSync(
  new URL('boot.js', dist),
  `
${polyfills}
${prologue};
${ses}
// Keep Array.prototype[Symbol.iterator] as a frozen native data property.
// Ironhorse's typed-array copy profile refuses accessor-based iterator overrides.
lockdown({ errorTaming: 'safe', reporting: 'none', overrideTaming: 'min' });
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
