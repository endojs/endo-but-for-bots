// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import url from 'url';
import bundleSource from '@endo/bundle-source';
import { importBundle } from '@endo/import-bundle';

// @endo/eventual-send and @endo/patterns import .ts runtime modules from
// their workspace sources, so bundles that reach them must strip types.
test('bundles an entry that reaches workspace .ts modules', async t => {
  const entryPath = url.fileURLToPath(
    new URL('_bundle-ts-reach.js', import.meta.url),
  );
  const bundle = await bundleSource(entryPath);
  const namespace = await importBundle(bundle, {
    endowments: { assert, harden },
  });
  t.deepEqual(namespace.kinds, ['function', 'function']);
});
