import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';
import { makeExo } from '@endo/exo';
import { Far } from '@endo/pass-style';
import { readableNameHubMethodGuards } from '@endo/platform/fs/lite';

import {
  isReadOnlyDirectoryFormula,
  readOnlyDirectorySource,
} from '../src/directory.js';

// `isReadOnlyDirectoryFormula` is the daemon-internal recognizer for the
// evaluation recipe that mints a read-only directory view. Its call sites live
// in later slices of the #1125 stack (network discovery reaching the backing
// directory), so this slice exercises the predicate directly: it must accept
// exactly the recipe `EndoDirectory.readOnly()` formulates and reject every
// near-miss, since a false positive would let discovery treat an unrelated
// eval formula as a read-only directory.

/**
 * @param {string} [id] the formula identifier bound to the `hub` endowment.
 * @returns {any} the exact formula `readOnly()` mints, `hub` bound to `id`.
 */
const readOnlyFormula = (id = 'directory-id') => ({
  type: 'eval',
  source: readOnlyDirectorySource,
  names: ['hub'],
  values: [id],
});

test('isReadOnlyDirectoryFormula accepts the read-only directory recipe', t => {
  t.true(isReadOnlyDirectoryFormula(readOnlyFormula()));
});

test('isReadOnlyDirectoryFormula rejects near-miss eval formulas', t => {
  // Wrong formula type.
  t.false(isReadOnlyDirectoryFormula({ ...readOnlyFormula(), type: 'lookup' }));
  // Right shape, foreign source.
  t.false(
    isReadOnlyDirectoryFormula({
      ...readOnlyFormula(),
      source: 'readOnly(hub)',
    }),
  );
  // Extra endowment beyond the single `hub`.
  t.false(
    isReadOnlyDirectoryFormula({
      ...readOnlyFormula(),
      names: ['hub', 'other'],
      values: ['directory-id', 'other-id'],
    }),
  );
  // Single endowment, but not named `hub`.
  t.false(
    isReadOnlyDirectoryFormula({
      ...readOnlyFormula(),
      names: ['notHub'],
    }),
  );
  // Endowment name present but no bound value.
  t.false(isReadOnlyDirectoryFormula({ ...readOnlyFormula(), values: [] }));
});

// The read-only view's interface guard is hand-reconstructed as a string inside
// `readOnlyDirectorySource`, because the worker compartment that evaluates it
// cannot import `@endo/platform`'s canonical `readableNameHubMethodGuards`. This
// test pins the two together: it evaluates the source exactly as the worker does
// (a Compartment endowed with `E`, `makeExo`, `M`, and `hub`) and asserts the
// minted exo's method names still equal the canonical record, so a future edit
// to either declaration that drifts the attenuation boundary is caught here.
test('readOnlyDirectorySource mirrors the canonical ReadableNameHub surface', async t => {
  const hub = Far('StubHub', {
    help: () => 'stub',
    has: async () => false,
    list: async () => [],
    lookup: async () => undefined,
    maybeLookup: async () => undefined,
  });
  const compartment = new Compartment(harden({ E, makeExo, M, hub }));
  const view = compartment.evaluate(readOnlyDirectorySource);
  // eslint-disable-next-line no-underscore-dangle
  const methodNames = await E(/** @type {any} */ (view)).__getMethodNames__();
  // Drop the exo meta-methods (`__getInterfaceGuard__`, `__getMethodNames__`)
  // so only the declared interface surface is compared.
  const declared = [...methodNames]
    .filter(name => !name.startsWith('__'))
    .sort();
  t.deepEqual(declared, Object.keys(readableNameHubMethodGuards).sort());
});
