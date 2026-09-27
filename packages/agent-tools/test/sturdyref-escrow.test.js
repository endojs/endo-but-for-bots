// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { makeSturdyRef } from '@endo/pass-style';
import { makeSturdyRefEscrow } from '../src/sturdyref-escrow.js';

const makeEscrow = () => {
  let next = 0;
  return makeSturdyRefEscrow({
    randomBytes: bytes => {
      bytes.fill(next);
      next += 1;
      return bytes;
    },
  });
};

test('renders a sturdyref as a fresh opaque handle and redeems only that handle', t => {
  const escrow = makeEscrow();
  const sturdyRef = makeSturdyRef();
  const first = /** @type {{ ref: string }} */ (
    escrow.render(harden({ ref: sturdyRef }))
  );
  const second = /** @type {{ ref: string }} */ (
    escrow.render(harden({ ref: sturdyRef }))
  );

  t.regex(first.ref, /^sturdyref:[0-9a-f]{32}$/);
  t.not(first.ref, second.ref, 'two grants are unlinkable in the transcript');
  t.false(first.ref.includes('locator'));
  t.deepEqual(escrow.redeem(first), harden({ ref: sturdyRef }));
  escrow.clear();
  t.throws(() => escrow.redeem(first), {
    message: 'unknown sturdyref handle',
  });
});

test('unknown sturdyref text fails before a tool can receive it', t => {
  const escrow = makeEscrow();
  t.throws(() => escrow.redeem('sturdyref:forged'), {
    message: 'unknown sturdyref handle',
  });
});

test('escrow table stores only sturdyrefs and ordinary text stays ordinary', t => {
  const escrow = makeEscrow();
  t.deepEqual(
    escrow.render(harden({ plain: 'hello', count: 1 })),
    harden({ plain: 'hello', count: 1 }),
  );
  t.is(escrow.redeem('hello'), 'hello');
});
