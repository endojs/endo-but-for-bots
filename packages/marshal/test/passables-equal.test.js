// @ts-check

import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { makeTagged } from '@endo/pass-style';

import { passablesEqual } from './passables-equal.js';

test('passablesEqual compares byte-array leaves by contents', t => {
  const actual = harden({
    nested: [frozenBytes(new Uint8Array([0x01, 0x23, 0x45]))],
    tagged: makeTagged('bytes', frozenBytes(new Uint8Array([0x67, 0x89]))),
  });
  const expected = harden({
    nested: [frozenBytes(new Uint8Array([0x01, 0x23, 0x45]))],
    tagged: makeTagged('bytes', frozenBytes(new Uint8Array([0x67, 0x89]))),
  });

  passablesEqual(t, actual, expected);
});

test('passablesEqual gives deepEqual diagnostics for byte-array leaves', async t => {
  const actual = harden({ bytes: frozenBytes(new Uint8Array([0x01, 0x23])) });
  const expected = harden({ bytes: frozenBytes(new Uint8Array([0x01, 0x45])) });

  const attempt = await t.try(tt =>
    passablesEqual(tt, actual, expected, 'byte mismatch'),
  );
  attempt.discard();
  t.false(attempt.passed);
  const [error] = attempt.errors;
  t.is(error.message, 'byte mismatch');
  const { formattedDetails } =
    /**
     * @type {Error & {
     *   formattedDetails: Array<{ label: string, formatted: string }>,
     * }}
     */ (/** @type {unknown} */ (error));
  t.deepEqual(
    formattedDetails.map(({ label }) => label),
    ['Difference (- actual, + expected):'],
  );
  t.regex(formattedDetails[0].formatted, /0123/);
  t.regex(formattedDetails[0].formatted, /0145/);
});
