// @ts-check

import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { Far, makeTagged } from '@endo/pass-style';

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

test('passablesEqual compares remotables by sharing topology', async t => {
  const widget = Far('Widget', {});
  const twin = Far('Widget', {});

  // A reference reused within an operand compares equal to the same reuse in
  // the other operand.
  passablesEqual(
    t,
    harden({ a: widget, b: [widget] }),
    harden({ a: widget, b: [widget] }),
  );

  // Distinct-but-corresponding references (as produced by a round-trip that
  // reconstructs each remotable) compare equal because each operand tracks
  // identity within itself.
  passablesEqual(t, harden([widget]), harden([twin]));

  // An aliasing difference — one operand shares a reference the other does not
  // — compares unequal.
  const attempt = await t.try(tt =>
    passablesEqual(tt, harden([widget, widget]), harden([widget, twin])),
  );
  attempt.discard();
  t.false(attempt.passed);
});

test('passablesEqual compares errors by name, message, and topology', async t => {
  const err = harden(Error('boom'));
  const twin = harden(Error('boom'));

  // A reconstructed error (distinct identity, same diagnostic) compares equal.
  passablesEqual(t, harden([err]), harden([twin]));

  // A differing message compares unequal, so error round-trips stay checked.
  const attempt = await t.try(tt =>
    passablesEqual(
      tt,
      harden([harden(Error('boom'))]),
      harden([harden(Error('bang'))]),
    ),
  );
  attempt.discard();
  t.false(attempt.passed);

  // An aliasing difference compares unequal.
  const aliasAttempt = await t.try(tt =>
    passablesEqual(tt, harden([err, err]), harden([err, twin])),
  );
  aliasAttempt.discard();
  t.false(aliasAttempt.passed);
});
