// Regression: a module containing a static-string-literal dynamic `import()`
// must still bundle. The archive trace records the dynamic-import target in the
// module's `imports` so it is captured for archives, but a bundle does not wire
// dynamic import, so the bundler must not try to statically link that target
// (which previously produced a functor import for a binding the functor never
// declares, failing at bundle-execution time).

import 'ses';
import fs from 'fs';
import url from 'url';
import test from 'ava';
import { makeScript } from '../script.js';
import { makeReadPowers } from '../node-powers.js';

const { read } = makeReadPowers({ fs, url });

const fixture = new URL(
  'fixtures-dynamic-import-esm/node_modules/app/index.js',
  import.meta.url,
).toString();

test('a module with a dynamic import() can be bundled', async t => {
  // The dynamic-import target (./foo.js) is reached only via `import('./foo.js')`;
  // bundling must succeed and not statically link it into the functor graph.
  const bundle = await makeScript(read, fixture);
  t.assert(typeof bundle === 'string' && bundle.length > 0);
  // The bundle must be evaluable: linking the entry module previously threw a
  // TypeError because the bundler emitted an `observeImports` call for the
  // dynamic-import target, a binding the functor never declares.
  const compartment = new Compartment({ __options__: true });
  t.notThrows(() => compartment.evaluate(bundle));
});
