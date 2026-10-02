// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { makeAdapterKeeper } from '../src/adapter-keeper.js';
import { makeAdapter } from '../src/native/adapter-kit.js';
import { makeManager } from '../src/native/manager-kit.js';

/**
 * A deterministic adapter double: it records binds and unbinds, and can be
 * told to fail either. The kit is what is under test; the adapter kit has
 * its own test.
 */
const fixture = () => {
  /** @type {Map<unknown, unknown>} */
  const bound = new Map();
  /** @type {string[]} */
  const log = [];
  let failBind = false;
  let failUnbind = false;
  let incarnations = 0;
  /**
   * A registration for `r` resolves: the resource settles its slot number
   * at bind time, as a delay becomes a deadline.
   * @param {any} spec
   */
  const resolveSpec = spec =>
    spec.who === 'r' && spec.slot === undefined
      ? harden({ ...spec, slot: incarnations * 100 + spec.n })
      : undefined;
  const adapter = Far('Adapter', {
    /**
     * @param {unknown} key
     * @param {unknown} spec
     */
    bind: (key, spec) => {
      if (failBind) throw Error('resource unavailable');
      const resolved = resolveSpec(spec);
      bound.set(key, resolved ?? spec);
      log.push(`bind ${key}`);
      return resolved;
    },
    /** @param {unknown} key */
    unbind: key => {
      if (failUnbind) {
        failUnbind = false;
        throw Error('unbind interrupted');
      }
      log.push(`unbind ${key}`);
      return bound.delete(key);
    },
    /** @param {Array<[unknown, unknown]>} entries */
    restore: entries => {
      log.push(`restore ${entries.map(([key]) => key).join(',')}`);
      if (failBind)
        return harden(
          entries.map(([key]) =>
            harden({ key, error: 'resource unavailable' }),
          ),
        );
      return harden(
        entries.map(([key, spec]) => {
          const resolved = resolveSpec(spec);
          bound.set(key, resolved ?? spec);
          return harden(
            resolved === undefined ? { key } : { key, spec: resolved },
          );
        }),
      );
    },
    keys: () => harden([...bound.keys()]),
  });
  const adapters = Far('Launcher', {
    create: () => {
      incarnations += 1;
      return Far('Incarnation', {
        getRoot: () => adapter,
        retire: () => {
          log.push('retire');
          bound.clear();
        },
      });
    },
  });
  const manager = makeManager(
    { adapters, makeKeeper: makeAdapterKeeper },
    {
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
      /** @type {(key: unknown, spec: any) => Record<string, unknown>} */
      decorate: (_key, spec) => harden({ spec }),
    },
  );
  return {
    manager,
    bound,
    log,
    incarnations: () => incarnations,
    setFailBind: (/** @type {boolean} */ value) => {
      failBind = value;
    },
    failNextUnbind: () => {
      failUnbind = true;
    },
  };
};

test('a registration is reconciled, described, and closed by its own handle only', async t => {
  const { manager, bound, log } = fixture();
  const spec = harden({ who: 'a', n: 1 });
  const registered = await manager.register('one', spec);
  t.deepEqual(
    registered.status,
    { spec, key: 'one', status: 'bound' },
    'register reports what reconciling found',
  );
  const first = registered.handle;
  t.deepEqual(await E(first).status(), { key: 'one', spec, status: 'bound' });
  t.true(bound.has('one'));
  t.is(
    (await manager.register('one', harden({ who: 'a', n: 1 }))).handle,
    first,
    'the same registration is the same handle',
  );
  t.deepEqual(manager.keys(), ['one']);
  t.true(await E(first).close());
  t.false(bound.has('one'));
  t.deepEqual(
    await E(first).status(),
    { key: 'one', status: 'closed' },
    'a closed handle no longer names what it was made with',
  );
  const second = (await manager.register('one', spec)).handle;
  t.not(second, first);
  t.false(
    await E(first).close(),
    'a stale handle cannot close a later generation',
  );
  t.true(bound.has('one'));
  t.true(await E(second).close());
  // The first registration builds the incarnation, which restores what is
  // desired so far, and then binds it again: the restore is the adapter's
  // baseline, the bind the reconciliation.
  t.deepEqual(log, [
    'restore one',
    'bind one', // register
    'bind one', // status reconciles
    'bind one', // the same registration again
    'unbind one', // close
    'bind one', // the second generation
    'unbind one', // its close; the stale handle's close touched nothing
  ]);
});

test('a differing registration replaces or is refused as the author decides', async t => {
  const { manager, bound } = fixture();
  const handle = (await manager.register('one', harden({ who: 'a', n: 1 })))
    .handle;
  const replaced = (await manager.register('one', harden({ who: 'a', n: 2 })))
    .handle;
  t.is(replaced, handle, 'a replacement keeps the handle');
  t.deepEqual(bound.get('one'), { who: 'a', n: 2 });
  await t.throwsAsync(
    () => manager.register('one', harden({ who: 'b', n: 2 })),
    { message: /Slot is already registered/ },
  );
  t.deepEqual(bound.get('one'), { who: 'a', n: 2 });
});

test('a failed bind keeps the desired state and reports it until it succeeds', async t => {
  const { manager, bound, setFailBind } = fixture();
  setFailBind(true);
  const handle = (await manager.register('one', harden({ who: 'a', n: 1 })))
    .handle;
  t.like(await E(handle).status(), {
    status: 'inactive',
    error: 'resource unavailable',
  });
  t.false(bound.has('one'));
  setFailBind(false);
  t.like(await E(handle).status(), { status: 'bound' });
  t.true(bound.has('one'));
});

test('an uncertain unbind retires the incarnation; the rest rebuild on next use', async t => {
  const { manager, bound, log, incarnations, failNextUnbind } = fixture();
  const first = (await manager.register('one', harden({ who: 'a', n: 1 })))
    .handle;
  const second = (await manager.register('two', harden({ who: 'b', n: 1 })))
    .handle;
  t.is(incarnations(), 1);
  failNextUnbind();
  t.true(await E(first).close());
  t.true(log.includes('retire'));
  t.false(bound.has('one'));
  t.like(await E(second).status(), { status: 'bound' });
  t.is(incarnations(), 2, 'a fresh incarnation restored the survivor');
  t.deepEqual(log.at(-2), 'restore two');
  t.false(bound.has('one'));
});

test('closing while no incarnation is live does not build one', async t => {
  const { manager, log, incarnations, failNextUnbind } = fixture();
  const first = (await manager.register('one', harden({ who: 'a', n: 1 })))
    .handle;
  const second = (await manager.register('two', harden({ who: 'b', n: 1 })))
    .handle;
  failNextUnbind();
  t.true(await E(first).close());
  t.is(incarnations(), 1);
  const before = log.length;
  t.true(await E(second).close());
  t.is(incarnations(), 1, 'nothing was built just to be told about a key');
  t.deepEqual(log.slice(before), [], 'and no adapter was spoken to');
  t.deepEqual(manager.keys(), []);
  await E(manager.lifecycle).started();
  t.is(incarnations(), 1, 'nothing desired, nothing rebuilt');
});

test('the manager refuses a construction that leaves out what it needs', t => {
  const adapters = Far('Launcher', { create: () => {} });
  const same = () => true;
  /** @param {any} options */
  const attempt = options =>
    makeManager({ adapters, makeKeeper: makeAdapterKeeper }, options);
  t.throws(() => attempt({ same }), { message: /needs a label/ });
  t.throws(() => attempt({ label: 'Slot' }), {
    message: /needs same\(\)/,
  });
  // The status record is the kit's own: nothing beyond the label and
  // sameness is needed to make a manager.
  t.notThrows(() => attempt({ label: 'Slot', same }));
});

test('startup rebuilds the adapter only when something is desired', async t => {
  const { manager, incarnations, log } = fixture();
  await E(manager.lifecycle).started();
  t.is(incarnations(), 0);
  const handle = (await manager.register('one', harden({ who: 'a', n: 1 })))
    .handle;
  t.is(incarnations(), 1);
  await E(manager.lifecycle).started();
  t.is(incarnations(), 1, 'a live incarnation is kept');
  await E(handle).close();
  await E(manager.lifecycle).started();
  t.is(incarnations(), 1);
  t.deepEqual(log.at(-1), 'unbind one');
});

test('a resolved spec is adopted as the desired one, described, and restored', async t => {
  const { manager, bound, log, failNextUnbind } = fixture();
  const handle = (await manager.register('one', harden({ who: 'r', n: 1 })))
    .handle;
  t.deepEqual(
    await E(handle).status(),
    { key: 'one', spec: { who: 'r', n: 1, slot: 101 }, status: 'bound' },
    'status describes what the registration became',
  );
  t.deepEqual(bound.get('one'), { who: 'r', n: 1, slot: 101 });
  // Retire the incarnation through an uncertain unbind of another key; the
  // survivor is restored in its resolved form, not the one first registered.
  const other = (await manager.register('two', harden({ who: 'b', n: 1 })))
    .handle;
  failNextUnbind();
  t.true(await E(other).close());
  t.like(await E(handle).status(), { status: 'bound', spec: { slot: 101 } });
  t.deepEqual(
    bound.get('one'),
    { who: 'r', n: 1, slot: 101 },
    'the second incarnation received the resolved spec, so it did not resolve again',
  );
  t.true(log.includes('restore one'));
});

test('an exit notice rebuilds the adapter only when something is desired', async t => {
  const { manager, incarnations, bound } = fixture();
  await E(manager.lifecycle).exited();
  t.is(incarnations(), 0, 'nothing desired, nothing rebuilt');
  const handle = (await manager.register('one', harden({ who: 'a', n: 1 })))
    .handle;
  t.is(incarnations(), 1);
  await E(manager.lifecycle).exited();
  t.is(incarnations(), 1, 'a live incarnation answers the probe and is kept');
  t.true(bound.has('one'));
  await E(handle).close();
  await E(manager.lifecycle).exited();
  t.is(incarnations(), 1);
});

test('over a resolving adapter, a first registration is bound once and adopted; a later one adopts from its bind', async t => {
  /** @type {string[]} */
  const log = [];
  let next = 0;
  /**
   * @param {{who: string, slot?: number}} a
   * @param {{who: string, slot?: number}} b
   */
  const same = (a, b) =>
    a.who === b.who && (b.slot === undefined || a.slot === b.slot);
  const adapter = makeAdapter({
    label: 'Slot',
    same,
    /**
     * @param {unknown} key
     * @param {{who: string, slot?: number}} spec
     */
    bind: async (key, spec) => {
      next += 1;
      log.push(`bind ${key} ${spec.slot ?? 'unresolved'}`);
      return next;
    },
    /**
     * @param {number} slot
     * @param {{who: string, slot?: number}} spec
     * @returns {{who: string, slot?: number}}
     */
    resolve: (slot, spec) =>
      spec.slot === undefined ? { ...spec, slot } : spec,
    unbind: async () => {
      log.push('unbind');
    },
  });
  const adapters = Far('Launcher', {
    create: () =>
      Far('Incarnation', { getRoot: () => adapter, retire: () => {} }),
  });
  const manager = makeManager(
    { adapters, makeKeeper: makeAdapterKeeper },
    {
      label: 'Slot',
      same,
      /** @type {(key: unknown, spec: any) => Record<string, unknown>} */
      decorate: (_key, spec) => harden({ spec }),
    },
  );
  // No incarnation yet: providing one restores this registration, which
  // resolves; the bind that follows must send the adopted form, or the
  // adapter would see a different registration under the same key.
  const first = (await manager.register('one', harden({ who: 'a' }))).handle;
  t.deepEqual(await E(first).status(), {
    key: 'one',
    spec: { who: 'a', slot: 1 },
    status: 'bound',
  });
  t.deepEqual(log, ['bind one unresolved'], 'bound once');
  // A live incarnation: adoption comes from the bind's own answer.
  const second = (await manager.register('two', harden({ who: 'b' }))).handle;
  t.deepEqual(await E(second).status(), {
    key: 'two',
    spec: { who: 'b', slot: 2 },
    status: 'bound',
  });
  t.is(
    (await manager.register('one', harden({ who: 'a' }))).handle,
    first,
    'the consumer may register the unresolved form again',
  );
  t.deepEqual(log, ['bind one unresolved', 'bind two unresolved']);
});
