// @ts-check

/**
 * Loads the pi-mono exports `src/agent/index.js` consumes *inside an
 * Endo Compartment* via `@endo/compartment-mapper`'s `importLocation`,
 * rather than into the surrounding Node ESM realm.
 *
 * This is the confined counterpart to {@link file://./pi-ses-compat.test.js}.
 * That test pins behavior in the unconfined / `--UNCONFINED` worker
 * realm — i.e. SES lockdown is in effect, but pi runs in the same
 * realm as everything else in the daemon worker process.  **This**
 * test pins behavior in a fresh Compartment whose module graph is
 * loaded through compartment-mapper's source parser — i.e. the bar an
 * Endo-confined formula would have to clear.
 *
 * This test verifies the behavior an Endo-confined formula needs from pi.
 *
 * Debug: see the header of `pi-ses-compat.test.js`.
 * `LOCKDOWN_ERROR_TAMING=unsafe-debug yarn test` un-redacts errors
 * thrown out of the Compartment.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'fs';
import crypto from 'crypto';
import url from 'url';

import { importLocation } from '@endo/compartment-mapper/import.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';

const readPowers = makeReadPowers({ fs, crypto, url });

const fixtureLocation = new URL(
  './fixtures/pi-confined-fixture.js',
  import.meta.url,
).toString();

const globals = { Float64Array, TextDecoder, TextEncoder };

test('pi-mono loads in a confined Endo Compartment', async t => {
  const application =
    /** @type {{ namespace: typeof import('./fixtures/pi-confined-fixture.js') } | undefined} */ (
      await importLocation(readPowers, fixtureLocation, {
        globals,
      }).catch(err => {
        t.fail(
          `pi-mono must load when compartment-mapper evaluates its dependency graph: ${err}`,
        );
        return undefined;
      })
    );
  if (application === undefined) {
    return;
  }
  const { namespace: fixture } = application;

  t.deepEqual(
    fixture.types,
    {
      PiAgent: 'function',
      getModel: 'function',
      getProviders: 'function',
    },
    'the confined fixture should expose the expected pi entrypoint types',
  );

  t.true(
    fixture.providersProbe.ok,
    fixture.providersProbe.ok
      ? 'getProviders should run under confinement'
      : `getProviders should run under confinement: ${fixture.providersProbe.error}`,
  );
  if (fixture.providersProbe.ok) {
    const providerCount = fixture.providersProbe.value;
    t.is(
      typeof providerCount,
      'number',
      'getProviders should report a numeric provider count under confinement',
    );
    if (typeof providerCount === 'number') {
      t.true(
        providerCount > 0,
        'getProviders should report available providers under confinement',
      );
    }
  }

  t.true(
    fixture.getModelProbe.ok,
    fixture.getModelProbe.ok
      ? 'getModel should accept a model lookup under confinement'
      : `getModel should accept a model lookup under confinement: ${fixture.getModelProbe.error}`,
  );

  t.true(
    fixture.constructProbe.ok,
    fixture.constructProbe.ok
      ? 'PiAgent should construct under confinement'
      : `PiAgent should construct under confinement: ${fixture.constructProbe.error}`,
  );
});
