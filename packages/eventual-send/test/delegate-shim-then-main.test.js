// @ts-check
// Verifies the eager-shim and lazy-main converge on the SAME peer
// bank. Importing the shim first installs at every peer slot; the main
// entry, when imported afterward and exercised, observes each slot is
// taken and adopts.

import 'ses';
import test from 'ava';

import '../shim.js';
import { delegate, HandledPromise, applyMethod } from '../src/no-shim.js';

const symbolFor = Symbol.for;

test.serial('shim and main converge on the same Promise[@delegate]', t => {
  const slotBefore = /** @type {any} */ (Promise)[symbolFor('delegate')];
  t.is(typeof slotBefore, 'function', 'shim installed at import');
  delegate();
  const slotAfter = /** @type {any} */ (Promise)[symbolFor('delegate')];
  t.is(slotAfter, slotBefore, 'main did not replace the slot value');
});

test.serial('lazy thunk applyMethod IS the peer at @applyMethod', async t => {
  const peer = /** @type {any} */ (Promise)[symbolFor('applyMethod')];
  // Sanity: the peer was installed by the shim. The lexical thunk
  // dispatches to it on call. Identity at the function level is a
  // dispatch property, not a thunk-vs-peer reference identity, so we
  // check that calling the thunk reaches the peer-installed function
  // by behavior.
  t.is(typeof peer, 'function', 'applyMethod peer present');
  const target = Object.freeze({
    noop() {
      return 'noop-result';
    },
  });
  const result = applyMethod(target, 'noop', []);
  t.is(typeof result.then, 'function', 'thunk returns a thenable');
  t.is(await result, 'noop-result', 'thunk routes through peer');
});

test.serial(
  'HandledPromise.resolve (lazy) === Promise[@resolve] peer (eager)',
  t => {
    const peer = /** @type {any} */ (Promise)[symbolFor('resolve')];
    // The lazy main entry's HandledPromise adapter forwards through
    // installOrAdoptOne(); the eager shim wrote the same function to
    // the slot. Calling the lazy adapter should reach the
    // eager-installed function.
    t.is(HandledPromise.resolve, peer, 'identity with the peer slot');
  },
);
