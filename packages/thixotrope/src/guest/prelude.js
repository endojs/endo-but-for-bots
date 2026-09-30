// @ts-check
import { Fail, makeError, q } from '@endo/errors';
import { defineExoClass, defineExoClassKit, makeExo } from '@endo/exo';
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { M, matches, mustMatch } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSerialQueue } from '../serial-queue.js';

/**
 * The guest prelude: what every vat has in scope as globals, beside the
 * language and the shared intrinsics. It is the same record on every
 * engine, so a source evaluated in a vat, a bundle installed into one, and
 * a factory this package ships into one by its source text all see one
 * vocabulary. (The packages behind it read a few `ENDO_*` and `DEBUG`
 * environment options when their modules initialize; the XS engine has no
 * environment, and the Node replay doubles read the host's, so a host that
 * changes those between runs does not replay a Node journal identically.)
 *
 * A factory shipped by source runs in the host as a module and in the vat
 * as an expression, so it may import only names the prelude provides,
 * under those names: `import { E, Far } from '@endo/far'` is the host's
 * binding of the same functions the vat has as globals.
 *
 * Bundled guest code reads the names it wants off `globalThis` in one
 * destructure, typed as `GuestGlobals` (`@endo/thixotrope/guest.js`); only
 * `mustMatch`, an assertion, needs a binding of its own with an explicit
 * `GuestGlobals['mustMatch']` type for the type-checker to narrow through
 * it.
 */
export const guestPrelude = harden({
  E,
  Far,
  harden,
  makeExo,
  defineExoClass,
  defineExoClassKit,
  M,
  matches,
  mustMatch,
  passStyleOf,
  Fail,
  q,
  makeError,
  makePromiseKit,
  makeSerialQueue,
});

/** @typedef {typeof globalThis & typeof guestPrelude} GuestGlobals */
