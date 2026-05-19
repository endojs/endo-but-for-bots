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
 * ## Current state: pi is NOT confined-compatible
 *
 * `@mariozechner/pi-agent-core` depends on `typebox` (v1.1.37 at time
 * of writing), and every `typebox` `.mjs` source uses ES2020's
 * namespace re-export syntax:
 *
 *   // node_modules/.../typebox/build/system/arguments/index.mjs
 *   export * as Arguments from './arguments.mjs';
 *
 * `@endo/compartment-mapper`'s default source parser does not accept
 * `export * as X from '...'` and rejects each typebox module with
 * `Error transforming source ...: Cannot read properties of undefined
 * (reading 'name')`.  The result is a hard load failure with hundreds
 * of underlying transform errors before pi's own module bodies even
 * evaluate.
 *
 * This test pins that failure with `t.throwsAsync` so:
 *
 *   - CI stays green on the (correct) observation that pi is not
 *     confined-Compartment-loadable today.
 *   - If a future pi/typebox release switches to a syntax
 *     compartment-mapper accepts (or compartment-mapper learns to
 *     transform `export * as`), the assertion regresses and prompts
 *     us to switch to a positive-assertion test that checks each
 *     fixture probe.
 *
 * Once pi/typebox or compartment-mapper closes this gap, flip the
 * assertion below to inspect the fixture's `types`, `providersProbe`,
 * `getModelProbe`, and `constructProbe` exports.
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

test('pi-mono fails to load in a confined Endo Compartment (typebox `export * as` is not yet parseable)', async t => {
  const err = await t.throwsAsync(() =>
    importLocation(readPowers, fixtureLocation),
  );
  t.truthy(err);
  // The error is wrapped — the underlying cause names typebox and the
  // transform-source failure.  Match on both so a future regression
  // (e.g. typebox switches to ESM but pi keeps the same dep, or
  // compartment-mapper learns `export * as`) surfaces here.
  const message = /** @type {Error} */ (err).message;
  t.regex(
    message,
    /typebox/,
    'pi-mono is unloadable in a confined Compartment because typebox is — the message must name typebox so future failures are diagnosable',
  );
  t.regex(
    message,
    /Error transforming source/,
    'the failure mode is a compartment-mapper source-transform error, not a runtime throw inside pi',
  );
});
