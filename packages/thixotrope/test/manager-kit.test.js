// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { makeAdapterKeeper } from '../src/adapter-keeper.js';
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
  const adapter = Far('Adapter', {
    /**
     * @param {unknown} key
     * @param {unknown} spec
     */
    bind: (key, spec) => {
      if (failBind) throw Error('resource unavailable');
      bound.set(key, spec);
      log.push(`bind ${key}`);
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
      for (const [key, spec] of entries) bound.set(key, spec);
      return harden(entries.map(([key]) => harden({ key })));
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
      describe: (key, spec, state, error) =>
        harden({ key, spec, state, ...(error === undefined ? {} : { error }) }),
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
  const first = await manager.register('one', spec);
  t.deepEqual(await E(first).status(), { key: 'one', spec, state: 'bound' });
  t.true(bound.has('one'));
  t.is(
    await manager.register('one', harden({ who: 'a', n: 1 })),
    first,
    'the same registration is the same handle',
  );
  t.deepEqual(manager.keys(), ['one']);
  t.true(await E(first).close());
  t.false(bound.has('one'));
  t.deepEqual(
    await E(first).status(),
    { key: 'one', spec: undefined, state: 'closed' },
    'a closed handle no longer names what it was made with',
  );
  const second = await manager.register('one', spec);
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
  const handle = await manager.register('one', harden({ who: 'a', n: 1 }));
  const replaced = await manager.register('one', harden({ who: 'a', n: 2 }));
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
  const handle = await manager.register('one', harden({ who: 'a', n: 1 }));
  t.like(await E(handle).status(), {
    state: 'inactive',
    error: 'resource unavailable',
  });
  t.false(bound.has('one'));
  setFailBind(false);
  t.like(await E(handle).status(), { state: 'bound' });
  t.true(bound.has('one'));
});

test('an uncertain unbind retires the incarnation; the rest rebuild on next use', async t => {
  const { manager, bound, log, incarnations, failNextUnbind } = fixture();
  const first = await manager.register('one', harden({ who: 'a', n: 1 }));
  const second = await manager.register('two', harden({ who: 'b', n: 1 }));
  t.is(incarnations(), 1);
  failNextUnbind();
  t.true(await E(first).close());
  t.true(log.includes('retire'));
  t.false(bound.has('one'));
  t.like(await E(second).status(), { state: 'bound' });
  t.is(incarnations(), 2, 'a fresh incarnation restored the survivor');
  t.deepEqual(log.at(-2), 'restore two');
  t.false(bound.has('one'));
});

test('closing while no incarnation is live does not build one', async t => {
  const { manager, log, incarnations, failNextUnbind } = fixture();
  const first = await manager.register('one', harden({ who: 'a', n: 1 }));
  const second = await manager.register('two', harden({ who: 'b', n: 1 }));
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
  const describe = () => harden({});
  const same = () => true;
  /** @param {any} options */
  const attempt = options =>
    makeManager({ adapters, makeKeeper: makeAdapterKeeper }, options);
  t.throws(() => attempt({ same, describe }), { message: /needs a label/ });
  t.throws(() => attempt({ label: 'Slot', describe }), {
    message: /needs same\(\)/,
  });
  t.throws(() => attempt({ label: 'Slot', same }), {
    message: /needs describe\(\)/,
  });
});

test('startup rebuilds the adapter only when something is desired', async t => {
  const { manager, incarnations, log } = fixture();
  await E(manager.lifecycle).started();
  t.is(incarnations(), 0);
  const handle = await manager.register('one', harden({ who: 'a', n: 1 }));
  t.is(incarnations(), 1);
  await E(manager.lifecycle).started();
  t.is(incarnations(), 1, 'a live incarnation is kept');
  await E(handle).close();
  await E(manager.lifecycle).started();
  t.is(incarnations(), 1);
  t.deepEqual(log.at(-1), 'unbind one');
});
