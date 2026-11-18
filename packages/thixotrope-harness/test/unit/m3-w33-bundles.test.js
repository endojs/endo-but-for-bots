// @ts-check
// What M3's manager side costs the vat programs (designs/m3-interfaces.md
// 3.1, 10 W3.3, 11 H1/H2): the session and exec programs carry no M3 module
// (`interfaces.js` is not edited, so their bundles do not grow), they stay
// within their budgets, and the agent-host manager bundle (`durable.js` as
// the supervisor bundles it) carries `durable-gateway.js` and
// `interfaces-m3.js`. Sizes are logged for the journal.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import test from '@endo/ses-ava/test.js';

import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import { limits } from '../../guest/lib/limits.js';

const harnessRoot = path.resolve(
  url.fileURLToPath(new URL('../..', import.meta.url)),
);
const guestRoot = path.join(harnessRoot, 'guest');

/**
 * Program budgets: the limits' (M5's merge raised them to 240,000 and
 * 120,000, contract O-1; INT-M5).
 */
const BUDGETS = harden({
  session: limits.sessionProgramBytes,
  exec: limits.execProgramBytes,
});

test('session and exec bundles carry no M3 module and fit their budgets', async t => {
  for (const program of ['session', 'exec', 'factory']) {
    // eslint-disable-next-line no-await-in-loop
    const bundle = await bundleGuest(path.join(guestRoot, program, 'main.js'), {
      guestRoot,
    });
    t.log(JSON.stringify({ program, bytes: bundle.bytes }));
    t.false(bundle.modules.includes('lib/interfaces-m3.js'), program);
    const budget = /** @type {Record<string, number>} */ (BUDGETS)[program];
    if (budget !== undefined) t.true(bundle.bytes <= budget, program);
  }
});

test('the manager bundle carries the gateway registration', async t => {
  // Loaded after lockdown (compartment-mapper reads `assert` when it loads).
  const [{ makeBundle }, { makeReadPowers }] = await Promise.all([
    import('@endo/compartment-mapper/bundle.js'),
    import('@endo/compartment-mapper/node-powers.js'),
  ]);
  const readPowers = makeReadPowers({ fs, url, crypto, path });
  const source = await makeBundle(
    readPowers,
    url.pathToFileURL(
      path.join(harnessRoot, 'resources', 'agent-host', 'durable.js'),
    ).href,
  );
  const bytes = Buffer.byteLength(source);
  t.log(JSON.stringify({ program: 'manager', bytes }));
  // Module names are not kept in the bundle; their exports' names are.
  t.true(source.includes('makeGatewayManager'), 'durable-gateway.js');
  t.true(source.includes('withGatewayAdmin'), 'interfaces-m3.js');
});
