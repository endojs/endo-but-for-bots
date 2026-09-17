import test from '@endo/ses-ava/prepare-endo.js';

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
