// @ts-check

import test from '@endo/ses-ava/test.js';

import { PASS_STYLE } from '@endo/pass-style';
import { makeSubscribableKit } from '@endo/eventual-send';

test('PASS_STYLE symbol agreement across @endo/pass-style and @endo/eventual-send', t => {
  // Regression guard for the cross-realm `Symbol.for('passStyle')`
  // agreement: `@endo/eventual-send/src/pass-style-promise.js` re-derives
  // the symbol locally via `Symbol.for('passStyle')` rather than importing
  // from `@endo/pass-style` (to avoid the dependency cycle, since
  // `@endo/pass-style` depends on `@endo/eventual-send`). The two sites
  // must therefore agree by construction; if a future rename of the
  // symbol identifier in either package breaks the agreement, every
  // `passStyleOf(carrier)` against an eventual-send-minted carrier
  // would silently misclassify.
  //
  // We assert this by comparing the symbol on a carrier minted by
  // `makeSubscribableKit` (which uses eventual-send's local re-derivation)
  // against the `PASS_STYLE` symbol exported from `@endo/pass-style`.
  const { promise } = makeSubscribableKit();
  // The symbol used as the carrier's PASS_STYLE key must be the same
  // identity as the PASS_STYLE export from @endo/pass-style.
  const ownSymbols = Object.getOwnPropertySymbols(promise);
  t.true(
    ownSymbols.includes(PASS_STYLE),
    'eventual-send carrier uses the same PASS_STYLE symbol as @endo/pass-style',
  );
  // And the canonical Symbol.for source agrees with both.
  t.is(PASS_STYLE, Symbol.for('passStyle'));
});
