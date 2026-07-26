// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeSturdyRef } from '@endo/pass-style';
import { makeSturdyRefEscrow } from '../src/sturdyref-escrow.js';

test('escrow renders SturdyRefs as opaque transcript-local handles', t => {
  const escrow = makeSturdyRefEscrow();
  const sturdyRef = makeSturdyRef();
  const rendered = escrow.render(harden({ ref: sturdyRef }));
  const handle = /** @type {{ ref: string }} */ (rendered).ref;

  t.regex(handle, /^sturdyref:[0-9a-f]{36}$/u);
  t.false(handle.includes('location'));
  t.false(handle.includes('formula'));
  t.false(handle.includes('swiss'));
  t.is(escrow.redeem(handle), sturdyRef);
});

test('escrow mints unlinkable handles for separate grants of one value', t => {
  const escrow = makeSturdyRefEscrow();
  const sturdyRef = makeSturdyRef();
  const first = /** @type {string} */ (escrow.render(sturdyRef));
  const second = /** @type {string} */ (escrow.render(sturdyRef));

  t.not(first, second);
  t.is(escrow.redeem(first), sturdyRef);
  t.is(escrow.redeem(second), sturdyRef);
});

test('escrow rejects arbitrary and unknown handles before dispatch', t => {
  const escrow = makeSturdyRefEscrow();
  t.throws(
    () => escrow.redeem('sturdyref:000000000000000000000000000000000000'),
    {
      message: 'unknown sturdyref handle',
    },
  );
  t.is(escrow.redeem('ordinary untrusted text'), 'ordinary untrusted text');
});

test('escrow only renders first-class SturdyRefs as handles', t => {
  const escrow = makeSturdyRefEscrow();
  const plain = harden({ value: 'not a reference' });
  t.deepEqual(escrow.render(plain), plain);
});
