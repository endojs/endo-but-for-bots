// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { assertGuestFormulaId, isGuestFormulaId } from '../src/formula-id.js';

const HEX64 = 'a'.repeat(64);

test('assertGuestFormulaId returns a well-formed 64-hex id unchanged', t => {
  // Branded return type is assignable to string, so compare with the string as
  // the inferred type to keep t.is well-typed.
  t.is(HEX64, assertGuestFormulaId(HEX64));
});

test('assertGuestFormulaId rejects the injection vectors a designator could carry', t => {
  // A quote breaks the JSON --mcp-config; a newline/CR splits the argv or injects
  // an Authorization header; wrong length / uppercase / non-string all fail closed.
  for (const bad of [
    `${'a'.repeat(63)}"`,
    `${'a'.repeat(62)}\n0`,
    `${'a'.repeat(62)}\r0`,
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    `${'a'.repeat(63)}g`,
    '',
    undefined,
    12_345,
    HEX64.split(''),
  ]) {
    t.throws(() => assertGuestFormulaId(/** @type {any} */ (bad)), {
      message: /64 lowercase hex/,
    });
  }
});

test('isGuestFormulaId is the non-throwing predicate form', t => {
  t.true(isGuestFormulaId(HEX64));
  t.false(isGuestFormulaId('a'.repeat(63)));
  t.false(isGuestFormulaId('A'.repeat(64)));
  t.false(isGuestFormulaId(`${'a'.repeat(63)}\n`));
  t.false(isGuestFormulaId(/** @type {any} */ (undefined)));
  t.false(isGuestFormulaId(/** @type {any} */ (42)));
});
