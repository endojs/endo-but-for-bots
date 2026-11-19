// @ts-check
// The attach helper every forwarding native manager uses
// (resources/native-attach.js; m6-interfaces.md D-M6-13): reconcile when
// nothing is attached, a read retried once after a retired break, a write
// never sent twice, other failures unchanged, one reconcile for a burst.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { makeAttachedOps } from '../../resources/native-attach.js';
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
import {
  HUB_RETIRED_MESSAGE,
  isRetiredBreak,
} from '../../guest/lib/retired.js';

/**
 * A fake adapter: each reconcile attaches a fresh facet whose `call` the
 * test can make break once (as a restart between apply and answer).
 */
const makeFixture = () => {
  let reconciles = 0;
  /** @type {string[]} */
  const applied = [];
  let breakNext = false;
  /** @type {any} */
  let attached;
  const makeFacet = (/** @type {number} */ incarnation) => {
    let retired = false;
    return harden({
      incarnation,
      call: async (/** @type {string} */ name) => {
        if (retired) throw Error(HUB_RETIRED_MESSAGE);
        applied.push(`${name}@${incarnation}`);
        if (breakNext) {
          breakNext = false;
          retired = true;
          throw Error(HUB_RETIRED_MESSAGE);
        }
        return `${name} done by ${incarnation}`;
      },
    });
  };
  const ops = makeAttachedOps({
    reconcile: async () => {
      reconciles += 1;
      await null;
      ops.attach(makeFacet(reconciles));
    },
    isRetired: isRetiredBreak,
    writeBroken: () => Error('outcome unknown'),
  });
  attached = ops;
  return {
    ops: attached,
    applied,
    reconciles: () => reconciles,
    breakNext: () => {
      breakNext = true;
    },
  };
};

test('the first call reconciles; later calls use the attached facet', async t => {
  const { ops, reconciles } = makeFixture();
  t.is(ops.current(), undefined);
  t.is(await ops.withOps(facet => facet.call('a')), 'a done by 1');
  t.is(await ops.withOps(facet => facet.call('b')), 'b done by 1');
  t.is(reconciles(), 1);
  t.is(ops.current().incarnation, 1);
});

test('a read that meets a retired break reconciles and is called once more', async t => {
  const { ops, applied, reconciles, breakNext } = makeFixture();
  await ops.withOps(facet => facet.call('warm'));
  breakNext();
  t.is(await ops.withOps(facet => facet.call('read')), 'read done by 2');
  t.deepEqual(applied, ['warm@1', 'read@1', 'read@2']);
  t.is(reconciles(), 2);
});

test('a write that meets a retired break is not sent again and rejects', async t => {
  const { ops, applied, reconciles, breakNext } = makeFixture();
  await ops.withOps(facet => facet.call('warm'));
  breakNext();
  await t.throwsAsync(
    ops.withOps(facet => facet.call('commit'), { write: true }),
    { message: 'outcome unknown' },
  );
  t.deepEqual(applied, ['warm@1', 'commit@1']);
  // The broken facet is dropped: the next write reconciles first instead of
  // breaking on the dead facet again.
  t.is(ops.current(), undefined);
  t.is(
    await ops.withOps(facet => facet.call('commit2'), { write: true }),
    'commit2 done by 2',
  );
  t.is(reconciles(), 2);
});

test('a failure that is not a retired break passes through unchanged', async t => {
  const { ops, reconciles } = makeFixture();
  const refusal = Error('refused by the adapter');
  await t.throwsAsync(
    ops.withOps(async () => {
      throw refusal;
    }),
    { is: refusal },
  );
  t.is(reconciles(), 1);
  t.not(ops.current(), undefined);
});

test('a burst of calls with nothing attached makes one reconcile', async t => {
  const { ops, reconciles } = makeFixture();
  const answers = await Promise.all(
    ['a', 'b', 'c', 'd'].map(name => ops.withOps(facet => facet.call(name))),
  );
  t.deepEqual(answers, [
    'a done by 1',
    'b done by 1',
    'c done by 1',
    'd done by 1',
  ]);
  t.is(reconciles(), 1);
});

test('a reconcile that attaches nothing fails the call plainly', async t => {
  const ops = makeAttachedOps({
    reconcile: async () => {},
    isRetired: isRetiredBreak,
  });
  await t.throwsAsync(
    ops.withOps(async () => 'never'),
    { message: 'the adapter did not attach' },
  );
});
