// @ts-check
import { E } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { makeAdapter } from '../native-adapter.js';

/**
 * An adapter over a fake resource: binding acquires a token, unbinding
 * releases it, one key cannot be bound, and one release can be made to fail.
 */
const fixture = () => {
  /** @type {string[]} */
  const log = [];
  let next = 0;
  let failUnbind = false;
  const adapter = makeAdapter({
    label: 'Slot',
    /**
     * @param {{who: string, n: number}} a
     * @param {{who: string, n: number}} b
     */
    same: (a, b) => a.who === b.who && a.n === b.n,
    /**
     * @param {{who: string}} a
     * @param {{who: string}} b
     */
    replaces: (a, b) => a.who === b.who,
    /**
     * @param {unknown} key
     * @param {{who: string, n: number}} spec
     */
    bind: async (key, spec) => {
      if (key === 'broken') throw Error('cannot bind broken');
      next += 1;
      log.push(`bind ${key} ${spec.who}${spec.n} -> ${next}`);
      return next;
    },
    /**
     * @param {number} token
     * @param {unknown} key
     */
    unbind: async (token, key) => {
      if (failUnbind) {
        failUnbind = false;
        throw Error('release interrupted');
      }
      log.push(`unbind ${key} ${token}`);
    },
  });
  return {
    adapter,
    log,
    failNextUnbind: () => {
      failUnbind = true;
    },
  };
};

/**
 * An adapter whose registrations resolve at bind time: the slot number the
 * resource handed out becomes part of the registration, as a delay becomes
 * a deadline or a port of zero becomes the port a listener got.
 */
const resolvingFixture = () => {
  /** @type {string[]} */
  const log = [];
  let next = 0;
  const adapter = makeAdapter({
    label: 'Slot',
    /**
     * @param {{who: string, slot?: number}} a
     * @param {{who: string, slot?: number}} b
     */
    same: (a, b) =>
      a.who === b.who && (b.slot === undefined || a.slot === b.slot),
    /**
     * @param {unknown} key
     * @param {{who: string, slot?: number}} spec
     */
    bind: async (key, spec) => {
      next += 1;
      log.push(`bind ${key} ${spec.who} -> ${next}`);
      return next;
    },
    /**
     * A registration already resolved stays as it is: the manager sends the
     * resolved form back on every restore.
     * @param {number} slot
     * @param {{who: string, slot?: number}} spec
     * @returns {{who: string, slot?: number}}
     */
    resolve: (slot, spec) =>
      spec.slot === undefined ? { ...spec, slot } : spec,
    /**
     * @param {number} slot
     * @param {unknown} key
     */
    unbind: async (slot, key) => {
      log.push(`unbind ${key} ${slot}`);
    },
  });
  return { adapter, log };
};

test('a repeated bind of the same registration changes nothing', async t => {
  const { adapter, log } = fixture();
  t.is(await E(adapter).bind('one', harden({ who: 'a', n: 1 })), undefined);
  t.is(await E(adapter).bind('one', harden({ who: 'a', n: 1 })), undefined);
  t.deepEqual(log, ['bind one a1 -> 1']);
  t.deepEqual(await E(adapter).keys(), ['one']);
});

test('a replaceable registration is released before the new one is bound; others are refused', async t => {
  const { adapter, log } = fixture();
  await E(adapter).bind('one', harden({ who: 'a', n: 1 }));
  await E(adapter).bind('one', harden({ who: 'a', n: 2 }));
  t.deepEqual(log, ['bind one a1 -> 1', 'unbind one 1', 'bind one a2 -> 2']);
  await t.throwsAsync(
    () => E(adapter).bind('one', harden({ who: 'b', n: 2 })),
    { message: /Slot is already registered/ },
  );
  t.deepEqual(log.length, 3, 'a refused bind touches nothing');
});

test('a replacement whose release fails stays bound until a release succeeds', async t => {
  const { adapter, log, failNextUnbind } = fixture();
  await E(adapter).bind('one', harden({ who: 'a', n: 1 }));
  failNextUnbind();
  await t.throwsAsync(
    () => E(adapter).bind('one', harden({ who: 'a', n: 2 })),
    { message: /release interrupted/ },
  );
  t.deepEqual(await E(adapter).keys(), ['one'], 'the old binding is kept');
  t.deepEqual(log, ['bind one a1 -> 1'], 'and nothing new was bound');
  failNextUnbind();
  await t.throwsAsync(() => E(adapter).unbind('one'), {
    message: /release interrupted/,
  });
  t.deepEqual(await E(adapter).keys(), ['one'], 'a failed unbind keeps it');
  t.true(await E(adapter).unbind('one'), 'until one succeeds');
  t.deepEqual(await E(adapter).keys(), []);
  t.deepEqual(log, ['bind one a1 -> 1', 'unbind one 1']);
});

test('the adapter refuses a construction that leaves out what it needs', t => {
  const same = () => true;
  const bind = () => 1;
  const unbind = () => {};
  /** @param {any} options */
  const attempt = options => makeAdapter(options);
  t.throws(() => attempt({ same, bind, unbind }), { message: /needs a label/ });
  t.throws(() => attempt({ label: 'Slot', bind, unbind }), {
    message: /needs same\(\)/,
  });
  t.throws(() => attempt({ label: 'Slot', same, bind }), {
    message: /needs bind\(\) and unbind\(\)/,
  });
});

test('unbind releases the binding and reports whether there was one', async t => {
  const { adapter, log } = fixture();
  t.false(await E(adapter).unbind('one'));
  await E(adapter).bind('one', harden({ who: 'a', n: 1 }));
  t.true(await E(adapter).unbind('one'));
  t.false(await E(adapter).unbind('one'));
  t.deepEqual(log, ['bind one a1 -> 1', 'unbind one 1']);
  t.deepEqual(await E(adapter).keys(), []);
});

test('restore binds each entry and reports failures without giving up', async t => {
  const { adapter } = fixture();
  const spec = harden({ who: 'a', n: 1 });
  const results = await E(adapter).restore(
    harden([
      ['one', spec],
      ['broken', spec],
      ['two', spec],
    ]),
  );
  t.deepEqual(results, [
    { key: 'one' },
    { key: 'broken', error: 'cannot bind broken' },
    { key: 'two' },
  ]);
  t.deepEqual(await E(adapter).keys(), ['one', 'two']);
});

test('a bind answers undefined when the registration is as sent', async t => {
  const { adapter } = fixture();
  t.is(await E(adapter).bind('one', harden({ who: 'a', n: 1 })), undefined);
  t.deepEqual(await E(adapter).restore(harden([['two', { who: 'b', n: 1 }]])), [
    { key: 'two' },
  ]);
});

test('a resolving adapter answers what the registration became, and keeps it', async t => {
  const { adapter, log } = resolvingFixture();
  t.deepEqual(await E(adapter).bind('one', harden({ who: 'a' })), {
    who: 'a',
    slot: 1,
  });
  t.deepEqual(
    await E(adapter).bind('one', harden({ who: 'a' })),
    { who: 'a', slot: 1 },
    'the unresolved form again is the standing registration, answered resolved',
  );
  t.deepEqual(
    await E(adapter).bind('one', harden({ who: 'a', slot: 1 })),
    { who: 'a', slot: 1 },
    'and so is the resolved form the manager adopted',
  );
  t.deepEqual(log, ['bind one a -> 1'], 'bound once');
  await t.throwsAsync(
    () => E(adapter).bind('one', harden({ who: 'a', slot: 7 })),
    { message: /Slot is already registered/ },
    'a resolved form that differs is a different registration',
  );
  t.true(await E(adapter).unbind('one'));
  t.is(log.at(-1), 'unbind one 1', 'unbind receives the binding, not the spec');
});

test('a restore reports each resolved registration with its resolved spec', async t => {
  const { adapter } = resolvingFixture();
  t.deepEqual(
    await E(adapter).restore(
      harden([
        ['one', { who: 'a' }],
        ['two', { who: 'b', slot: 9 }],
      ]),
    ),
    [
      { key: 'one', spec: { who: 'a', slot: 1 } },
      { key: 'two', spec: { who: 'b', slot: 9 } },
    ],
    'an unresolved entry resolves; a resolved one round-trips as it is',
  );
  t.deepEqual(await E(adapter).keys(), ['one', 'two']);
});

test('resolve, when given, must be a function', t => {
  /** @param {any} options */
  const attempt = options => makeAdapter(options);
  t.throws(
    () =>
      attempt({
        label: 'Slot',
        same: () => true,
        bind: () => 1,
        unbind: () => {},
        resolve: 'later',
      }),
    { message: /resolve must be a function/ },
  );
});

test('a resolve that throws releases the binding and fails the bind', async t => {
  /** @type {string[]} */
  const log = [];
  const adapter = makeAdapter({
    label: 'Slot',
    /** @type {(a: {}, b: {}) => boolean} */
    same: () => true,
    /** @type {(key: unknown, spec: {}) => Promise<number>} */
    bind: async () => {
      log.push('bind');
      return 1;
    },
    /** @type {(slot: number, spec: {}) => {}} */
    resolve: () => {
      throw Error('address unavailable');
    },
    unbind: async (/** @type {number} */ slot) => {
      log.push(`unbind ${slot}`);
    },
  });
  await t.throwsAsync(() => E(adapter).bind('one', harden({})), {
    message: /address unavailable/,
  });
  t.deepEqual(log, ['bind', 'unbind 1'], 'the resource was released');
  t.deepEqual(await E(adapter).keys(), [], 'and nothing is kept under the key');
});
