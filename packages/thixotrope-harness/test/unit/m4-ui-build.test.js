// @ts-check
// W4.7: M4's feature files collect through M3's registry (m4-interfaces.md
// 9.1 item 1, 16): `ui/src/features.js` in Node and `ui/build.mjs` for the
// bundle find the Secrets panel, the Subscriptions panel and the account
// chip, and the stylesheets of both directories go into the bundle.
import test from '@endo/ses-ava/prepare-endo.js';

import { buildUi, defaultSrcDir, listUiModules } from '../../ui/build.mjs';
import { features, featuresFor } from '../../ui/src/features.js';

test('M4 features are collected with their slots and labels', t => {
  const byId = new Map(features.map(item => [item.id, item]));
  t.is(byId.get('secrets')?.slot, 'app.panel');
  t.is(byId.get('secrets')?.label, 'Secrets');
  t.is(byId.get('accounts')?.slot, 'app.panel');
  t.is(byId.get('accounts')?.label, 'Subscriptions');
  t.is(byId.get('accounts.chip')?.slot, 'statusbar.chip');
  t.is(typeof byId.get('accounts.chip')?.when, 'function');
  t.true(
    featuresFor('statusbar.chip').some(item => item.id === 'accounts.chip'),
  );
  const { styleFiles } = listUiModules(defaultSrcDir);
  t.true(styleFiles.some(file => file.endsWith('secrets.css')));
  t.true(styleFiles.some(file => file.endsWith('accounts.css')));
});

test('the bundle builds with the M4 features', async t => {
  const summary = await buildUi({ write: false });
  t.true(summary.features >= 3);
  t.log(
    JSON.stringify({
      bytes: summary.bytes,
      gzipBytes: summary.gzipBytes,
      features: summary.features,
    }),
  );
});
