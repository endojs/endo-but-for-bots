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
  /** What the fake resource holds, by key, in acquisition order. */
  const held = new Map();
  const adapter = makeAdapter({
    label: 'Slot',
    /**
     * @param {unknown} key
     * @param {{who: string, n: number}} spec
     */
    bind: async (key, spec) => {
      if (key === 'broken') throw Error('cannot bind broken');
      next += 1;
      log.push(`bind ${key} ${spec.who}${spec.n} -> ${next}`);
      held.set(key, next);
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
      held.delete(key);
    },
  });
  return {
    adapter,
    log,
    held: () => [...held.keys()],
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
  /** What the fake resource holds, by key, in acquisition order. */
  const held = new Map();
  const adapter = makeAdapter({
    label: 'Slot',
    /**
     * @param {unknown} key
     * @param {{who: string, slot?: number}} spec
     */
    bind: async (key, spec) => {
      next += 1;
      log.push(`bind ${key} ${spec.who} -> ${next}`);
      held.set(key, next);
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
      held.delete(key);
    },
  });
  return {
    held: () => [...held.keys()],
    adapter,
    log,
  };
};

test('a repeated bind under the same epoch changes nothing', async t => {
  const { adapter, log, held } = fixture();
  t.is(await E(adapter).bind('one', harden({ who: 'a', n: 1 }), 1n), undefined);
  t.is(await E(adapter).bind('one', harden({ who: 'a', n: 1 }), 1n), undefined);
  t.deepEqual(log, ['bind one a1 -> 1']);
  t.deepEqual(held(), ['one']);
});

test('a bind under another epoch releases the standing binding before binding anew', async t => {
  const { adapter, log } = fixture();
  await E(adapter).bind('one', harden({ who: 'a', n: 1 }), 1n);
  await E(adapter).bind('one', harden({ who: 'a', n: 2 }), 2n);
  t.deepEqual(log, ['bind one a1 -> 1', 'unbind one 1', 'bind one a2 -> 2']);
  // Whatever the spec, the epoch decides: the manager alone says which
  // registrations may replace which.
  await E(adapter).bind('one', harden({ who: 'b', n: 2 }), 2n);
  t.is(log.length, 3, 'the same epoch is the standing registration');
});

test('a bind without an epoch is refused', async t => {
  const { adapter, log } = fixture();
  // A manager of another protocol, as an untyped peer would send.
  const untyped = /** @type {any} */ (adapter);
  await t.throwsAsync(
    () => E(untyped).bind('one', harden({ who: 'a', n: 1 })),
    { message: /Slot registration needs an epoch/ },
  );
  t.deepEqual(log, []);
});

test('a replacement whose release fails stays bound until a release succeeds', async t => {
  const { adapter, log, failNextUnbind, held } = fixture();
  await E(adapter).bind('one', harden({ who: 'a', n: 1 }), 1n);
  failNextUnbind();
  await t.throwsAsync(
    () => E(adapter).bind('one', harden({ who: 'a', n: 2 }), 2n),
    { message: /release interrupted/ },
  );
  t.deepEqual(held(), ['one'], 'the old binding is kept');
  t.deepEqual(log, ['bind one a1 -> 1'], 'and nothing new was bound');
  failNextUnbind();
  await t.throwsAsync(() => E(adapter).unbind('one'), {
    message: /release interrupted/,
  });
  t.deepEqual(held(), ['one'], 'a failed unbind keeps it');
  t.true(await E(adapter).unbind('one'), 'until one succeeds');
  t.deepEqual(held(), []);
  t.deepEqual(log, ['bind one a1 -> 1', 'unbind one 1']);
});

test('the adapter refuses a construction that leaves out what it needs', t => {
  const bind = () => 1;
  const unbind = () => {};
  /** @param {any} options */
  const attempt = options => makeAdapter(options);
  t.throws(() => attempt({ bind, unbind }), { message: /needs a label/ });
  t.throws(() => attempt({ label: 'Slot', bind }), {
    message: /needs bind\(\) and unbind\(\)/,
  });
  t.notThrows(() => attempt({ label: 'Slot', bind, unbind }));
});

test('unbind releases the binding and reports whether there was one', async t => {
  const { adapter, log, held } = fixture();
  t.false(await E(adapter).unbind('one'));
  await E(adapter).bind('one', harden({ who: 'a', n: 1 }), 1n);
  t.true(await E(adapter).unbind('one'));
  t.false(await E(adapter).unbind('one'));
  t.deepEqual(log, ['bind one a1 -> 1', 'unbind one 1']);
  t.deepEqual(held(), []);
});

test('restore binds each entry and reports failures without giving up', async t => {
  const { adapter, held } = fixture();
  const spec = harden({ who: 'a', n: 1 });
  const results = await E(adapter).restore(
    harden([
      ['one', spec, 1n],
      ['broken', spec, 2n],
      ['two', spec, 3n],
    ]),
  );
  t.deepEqual(results, [
    { key: 'one' },
    { key: 'broken', error: 'cannot bind broken' },
    { key: 'two' },
  ]);
  t.deepEqual(held(), ['one', 'two']);
});

test('a bind answers undefined when the registration is as sent', async t => {
  const { adapter } = fixture();
  t.is(await E(adapter).bind('one', harden({ who: 'a', n: 1 }), 1n), undefined);
  t.deepEqual(
    await E(adapter).restore(harden([['two', { who: 'b', n: 1 }, 2n]])),
    [{ key: 'two' }],
  );
});

test('a resolving adapter answers what the registration became, and keeps it', async t => {
  const { adapter, log } = resolvingFixture();
  t.deepEqual(await E(adapter).bind('one', harden({ who: 'a' }), 1n), {
    who: 'a',
    slot: 1,
  });
  t.deepEqual(
    await E(adapter).bind('one', harden({ who: 'a' }), 1n),
    { who: 'a', slot: 1 },
    'the unresolved form again is the standing registration, answered resolved',
  );
  t.deepEqual(
    await E(adapter).bind('one', harden({ who: 'a', slot: 1 }), 1n),
    { who: 'a', slot: 1 },
    'and so is the resolved form the manager adopted',
  );
  t.deepEqual(log, ['bind one a -> 1'], 'bound once');
  t.deepEqual(
    await E(adapter).bind('one', harden({ who: 'a', slot: 7 }), 2n),
    { who: 'a', slot: 7 },
    'a replacement under a new epoch is bound, and a resolved form kept',
  );
  t.deepEqual(log.slice(1), ['unbind one 1', 'bind one a -> 2']);
  t.true(await E(adapter).unbind('one'));
  t.is(log.at(-1), 'unbind one 2', 'unbind receives the binding, not the spec');
});

test('a restore reports each resolved registration with its resolved spec', async t => {
  const { adapter, held } = resolvingFixture();
  t.deepEqual(
    await E(adapter).restore(
      harden([
        ['one', { who: 'a' }, 1n],
        ['two', { who: 'b', slot: 9 }, 2n],
      ]),
    ),
    [
      { key: 'one', spec: { who: 'a', slot: 1 } },
      { key: 'two', spec: { who: 'b', slot: 9 } },
    ],
    'an unresolved entry resolves; a resolved one round-trips as it is',
  );
  t.deepEqual(held(), ['one', 'two']);
});

test('resolve, when given, must be a function', t => {
  /** @param {any} options */
  const attempt = options => makeAdapter(options);
  t.throws(
    () =>
      attempt({
        label: 'Slot',
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
  await t.throwsAsync(() => E(adapter).bind('one', harden({}), 1n), {
    message: /address unavailable/,
  });
  t.deepEqual(log, ['bind', 'unbind 1'], 'the resource was released');
  t.false(await E(adapter).unbind('one'), 'and nothing is kept under the key');
});
