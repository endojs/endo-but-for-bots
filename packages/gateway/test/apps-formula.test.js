// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E } from '@endo/far';

import {
  makeFormulaBackedAppsNameHub,
  validateWebletFormula,
} from '../index.js';

/** @import { AppsFormulaStore, WebletBindingRecord } from '../src/apps-formula.js' */

// ---- WebletFormula validator ----------------------------------------------

test('validateWebletFormula accepts the minimal shape', t => {
  const formula = validateWebletFormula({
    type: 'weblet',
    contentRoot: 'abc123',
  });
  t.is(formula.type, 'weblet');
  t.is(formula.contentRoot, 'abc123');
  t.true(Object.isFrozen(formula));
});

test('validateWebletFormula accepts optional fields', t => {
  const formula = validateWebletFormula({
    type: 'weblet',
    contentRoot: 'abc123',
    mimeTypes: { svg: 'image/svg+xml' },
    ssrHandler: 'def456',
    virtualHosts: ['chat.example.com', 'inbox.example.com'],
  });
  t.is(formula.mimeTypes && formula.mimeTypes.svg, 'image/svg+xml');
  t.is(formula.ssrHandler, 'def456');
  t.deepEqual(
    [...(formula.virtualHosts || [])],
    ['chat.example.com', 'inbox.example.com'],
  );
});

test('validateWebletFormula rejects a non-object', t => {
  t.throws(() => validateWebletFormula('not an object'), {
    message: /must be an object/,
  });
  t.throws(() => validateWebletFormula(null), {
    message: /must be an object/,
  });
  t.throws(() => validateWebletFormula([]), {
    message: /must be an object/,
  });
});

test('validateWebletFormula rejects a wrong type discriminator', t => {
  t.throws(
    () => validateWebletFormula({ type: 'readable-tree', contentRoot: 'abc' }),
    { message: /type must be 'weblet'/ },
  );
});

test('validateWebletFormula rejects a missing contentRoot', t => {
  t.throws(() => validateWebletFormula({ type: 'weblet' }), {
    message: /contentRoot must be a non-empty string/,
  });
  t.throws(() => validateWebletFormula({ type: 'weblet', contentRoot: '' }), {
    message: /contentRoot must be a non-empty string/,
  });
});

test('validateWebletFormula rejects malformed mimeTypes', t => {
  t.throws(
    () =>
      validateWebletFormula({
        type: 'weblet',
        contentRoot: 'abc',
        mimeTypes: 'oops',
      }),
    { message: /mimeTypes must be an object/ },
  );
  t.throws(
    () =>
      validateWebletFormula({
        type: 'weblet',
        contentRoot: 'abc',
        mimeTypes: { svg: '' },
      }),
    { message: /mimeTypes\["svg"\] must be a non-empty string/ },
  );
});

test('validateWebletFormula rejects a malformed ssrHandler', t => {
  t.throws(
    () =>
      validateWebletFormula({
        type: 'weblet',
        contentRoot: 'abc',
        ssrHandler: '',
      }),
    { message: /ssrHandler must be a non-empty string/ },
  );
});

test('validateWebletFormula rejects malformed virtualHosts', t => {
  t.throws(
    () =>
      validateWebletFormula({
        type: 'weblet',
        contentRoot: 'abc',
        virtualHosts: 'chat.example.com',
      }),
    { message: /virtualHosts must be an array/ },
  );
  t.throws(
    () =>
      validateWebletFormula({
        type: 'weblet',
        contentRoot: 'abc',
        virtualHosts: ['chat.example.com', ''],
      }),
    { message: /virtualHosts entries must be non-empty strings/ },
  );
});

// ---- in-memory test store -------------------------------------------------

/**
 * A fake `AppsFormulaStore` backed by an in-memory Map. Tests use
 * this as the "daemon-side persistence" the gateway consults. The
 * fake records every method call so assertions can pin write-through
 * behavior.
 *
 * @param {{
 *   seed?: ReadonlyArray<WebletBindingRecord>,
 *   listThrows?: unknown,
 *   listReturns?: unknown,
 *   writeThrows?: (name: string, id: string) => unknown,
 *   deleteThrows?: (name: string) => unknown,
 * }} [opts]
 */
const makeFakeStore = (opts = {}) => {
  /** @type {Map<string, string>} */
  const persisted = new Map();
  for (const { name, webletFormulaId } of opts.seed ?? []) {
    persisted.set(name, webletFormulaId);
  }
  /** @type {Array<['list'] | ['write', string, string] | ['delete', string]>} */
  const log = [];
  /** @type {AppsFormulaStore} */
  const store = {
    async listBindings() {
      log.push(['list']);
      if (opts.listThrows !== undefined) {
        throw opts.listThrows;
      }
      if (opts.listReturns !== undefined) {
        return /** @type {any} */ (opts.listReturns);
      }
      return harden(
        [...persisted].map(([name, webletFormulaId]) =>
          harden({ name, webletFormulaId }),
        ),
      );
    },
    async writeBinding(name, webletFormulaId) {
      log.push(['write', name, webletFormulaId]);
      if (opts.writeThrows !== undefined) {
        const err = opts.writeThrows(name, webletFormulaId);
        if (err !== undefined) {
          throw err;
        }
      }
      persisted.set(name, webletFormulaId);
    },
    async deleteBinding(name) {
      log.push(['delete', name]);
      if (opts.deleteThrows !== undefined) {
        const err = opts.deleteThrows(name);
        if (err !== undefined) {
          throw err;
        }
      }
      persisted.delete(name);
    },
  };
  return {
    store,
    /** @returns {ReadonlyArray<[string, string]>} The currently-persisted
     * bindings (sorted, for stable assertions). */
    snapshot() {
      return harden([...persisted].sort((a, b) => a[0].localeCompare(b[0])));
    },
    log,
  };
};

// ---- formula-backed hub: shape parity with the in-memory hub --------------

test('makeFormulaBackedAppsNameHub bind+lookup round-trips', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-id-abc');
});

test('makeFormulaBackedAppsNameHub lookup is case-insensitive', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await E(apps).bind('Chat.Example.COM', 'weblet-id-abc');
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-id-abc');
  t.is(await E(apps).lookup('CHAT.EXAMPLE.COM'), 'weblet-id-abc');
});

test('makeFormulaBackedAppsNameHub lookup throws for an unbound name', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await t.throwsAsync(() => E(apps).lookup('chat.example.com'), {
    message: /No virtual host bound for/,
  });
});

test('makeFormulaBackedAppsNameHub has reflects the binding', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  t.false(await E(apps).has('chat.example.com'));
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  t.true(await E(apps).has('chat.example.com'));
});

test('makeFormulaBackedAppsNameHub unbind removes the entry', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  await E(apps).unbind('chat.example.com');
  t.false(await E(apps).has('chat.example.com'));
});

test('makeFormulaBackedAppsNameHub rejects rebind to a different id', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  await t.throwsAsync(() => E(apps).bind('chat.example.com', 'weblet-id-xyz'), {
    message: /already bound to .* \(first-bind-wins\)/,
  });
});

test('makeFormulaBackedAppsNameHub allows idempotent rebind to the same id', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-id-abc');
});

test('makeFormulaBackedAppsNameHub list enumerates current bindings', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await E(apps).bind('chat.example.com', 'weblet-chat');
  await E(apps).bind('inbox.example.com', 'weblet-inbox');
  const entries = await E(apps).list();
  const names = entries.map(e => e.name).sort();
  t.deepEqual(names, ['chat.example.com', 'inbox.example.com']);
});

test('makeFormulaBackedAppsNameHub bind rejects an empty weblet id', async t => {
  const { store } = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await t.throwsAsync(() => E(apps).bind('chat.example.com', ''), {
    message: /non-empty string/,
  });
});

// ---- hydration & write-through ------------------------------------------

test('makeFormulaBackedAppsNameHub hydrates from the store on construction', async t => {
  // Regression: if a refactor stops calling listBindings at
  // construction (or stops applying the result to the in-memory
  // map), the persisted bindings vanish from the in-memory view on
  // every gateway restart. This test pins the hydration contract.
  const { store } = makeFakeStore({
    seed: [
      harden({ name: 'chat.example.com', webletFormulaId: 'weblet-chat' }),
      harden({ name: 'inbox.example.com', webletFormulaId: 'weblet-inbox' }),
    ],
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await E(apps).whenReady();
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-chat');
  t.is(await E(apps).lookup('inbox.example.com'), 'weblet-inbox');
});

test('makeFormulaBackedAppsNameHub hydration normalizes case', async t => {
  const { store } = makeFakeStore({
    seed: [
      harden({ name: 'Chat.Example.COM', webletFormulaId: 'weblet-chat' }),
    ],
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-chat');
});

test('makeFormulaBackedAppsNameHub write-through on bind', async t => {
  // Regression: if a refactor drops the writeBinding call, a
  // binding installed on one process does not survive restart. We
  // assert by inspecting the store's persisted snapshot.
  const fake = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  t.deepEqual(fake.snapshot(), [['chat.example.com', 'weblet-id-abc']]);
});

test('makeFormulaBackedAppsNameHub write-through normalizes the persisted name', async t => {
  // Persisted records carry the canonical (lowercased) name so the
  // next process's hydration sees the same key the in-memory map
  // uses. Regression: a refactor that stores the original-case name
  // would break the round-trip the first test pins.
  const fake = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await E(apps).bind('Chat.Example.COM', 'weblet-id-abc');
  t.deepEqual(fake.snapshot(), [['chat.example.com', 'weblet-id-abc']]);
});

test('makeFormulaBackedAppsNameHub write-through on unbind', async t => {
  const fake = makeFakeStore({
    seed: [
      harden({ name: 'chat.example.com', webletFormulaId: 'weblet-chat' }),
    ],
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await E(apps).whenReady();
  await E(apps).unbind('chat.example.com');
  t.deepEqual(fake.snapshot(), []);
});

test('makeFormulaBackedAppsNameHub rolls back the in-memory map when writeBinding throws', async t => {
  // Regression: if the store's write fails, the in-memory map must
  // not retain the binding (otherwise lookup would succeed while
  // the next process would not see the binding, a split-brain
  // condition). The hub re-throws the store's error.
  const fake = makeFakeStore({
    writeThrows: () => new Error('persistence failure'),
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await t.throwsAsync(() => E(apps).bind('chat.example.com', 'weblet-id-abc'), {
    message: 'persistence failure',
  });
  t.false(await E(apps).has('chat.example.com'));
});

test('makeFormulaBackedAppsNameHub rolls back the in-memory map when deleteBinding throws', async t => {
  const fake = makeFakeStore({
    seed: [
      harden({ name: 'chat.example.com', webletFormulaId: 'weblet-chat' }),
    ],
    deleteThrows: () => new Error('delete failure'),
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await E(apps).whenReady();
  await t.throwsAsync(() => E(apps).unbind('chat.example.com'), {
    message: 'delete failure',
  });
  // Rolled back: the binding is still reachable.
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-chat');
});

test('makeFormulaBackedAppsNameHub rejects an unrelated rebind even after the persisted record is in place', async t => {
  // First-bind-wins applies whether the existing binding came from
  // hydration or from a previous bind.
  const fake = makeFakeStore({
    seed: [
      harden({ name: 'chat.example.com', webletFormulaId: 'weblet-chat' }),
    ],
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await E(apps).whenReady();
  await t.throwsAsync(
    () => E(apps).bind('chat.example.com', 'weblet-different'),
    { message: /already bound to .* \(first-bind-wins\)/ },
  );
});

// ---- store-shape & hydration failure modes ------------------------------

test('makeFormulaBackedAppsNameHub rejects a missing formulaStore method at construction', t => {
  // Better to fail at construction than on first call: a misshapen
  // power should surface at the boundary, not later.
  t.throws(
    () =>
      makeFormulaBackedAppsNameHub({
        formulaStore: /** @type {any} */ ({}),
      }),
    { message: /AppsFormulaStore\..*listBindings.*must be a function/ },
  );
});

test('makeFormulaBackedAppsNameHub rejects a non-object formulaStore at construction', t => {
  t.throws(
    () =>
      makeFormulaBackedAppsNameHub({
        formulaStore: /** @type {any} */ (null),
      }),
    { message: /AppsFormulaStore must be an object/ },
  );
});

test('makeFormulaBackedAppsNameHub surfaces a listBindings failure through whenReady', async t => {
  // Fail-closed: a broken store at hydration is a startup error,
  // not a silent fallback to in-memory. Regression: if a refactor
  // catches the error and proceeds with an empty map, every
  // restart silently loses bindings.
  const { store } = makeFakeStore({
    listThrows: new Error('store offline'),
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await t.throwsAsync(() => E(apps).whenReady(), { message: 'store offline' });
});

test('makeFormulaBackedAppsNameHub surfaces a listBindings failure through subsequent calls', async t => {
  const { store } = makeFakeStore({
    listThrows: new Error('store offline'),
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await t.throwsAsync(() => E(apps).bind('chat.example.com', 'weblet-id-abc'), {
    message: 'store offline',
  });
});

test('makeFormulaBackedAppsNameHub rejects a non-array hydration result', async t => {
  // Regression: the validator's guard turns a misbehaving store
  // into a startup error rather than crashing on the next .map.
  const { store } = makeFakeStore({
    listReturns: 'not an array',
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await t.throwsAsync(() => E(apps).whenReady(), {
    message: /listBindings must return an array/,
  });
});

test('makeFormulaBackedAppsNameHub rejects a malformed hydration record', async t => {
  const { store } = makeFakeStore({
    listReturns: [{ name: 'chat.example.com' }], // missing webletFormulaId
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await t.throwsAsync(() => E(apps).whenReady(), {
    message: /malformed record/,
  });
});

test('makeFormulaBackedAppsNameHub rejects a duplicate hydration record with different ids', async t => {
  // If the store somehow contains two bindings for the same name
  // with different ids, the hub treats it as corruption rather
  // than silently picking one. The daemon-side store is expected
  // to enforce uniqueness; the hub's check is defense-in-depth.
  const { store } = makeFakeStore({
    listReturns: [
      { name: 'chat.example.com', webletFormulaId: 'weblet-a' },
      { name: 'chat.example.com', webletFormulaId: 'weblet-b' },
    ],
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await t.throwsAsync(() => E(apps).whenReady(), {
    message: /duplicate bindings for/,
  });
});

test('makeFormulaBackedAppsNameHub tolerates duplicate hydration records with the same id', async t => {
  // A store that returns the same record twice is benign (the hub
  // treats it as idempotent); regression: a strict check that
  // rejected even same-id duplicates would falsely fail on a
  // legitimate store implementation.
  const { store } = makeFakeStore({
    listReturns: [
      { name: 'chat.example.com', webletFormulaId: 'weblet-a' },
      { name: 'chat.example.com', webletFormulaId: 'weblet-a' },
    ],
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  t.is(await E(apps).lookup('chat.example.com'), 'weblet-a');
});

test('makeFormulaBackedAppsNameHub rejects an empty hydrated weblet id', async t => {
  const { store } = makeFakeStore({
    listReturns: [{ name: 'chat.example.com', webletFormulaId: '' }],
  });
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: store });
  await t.throwsAsync(() => E(apps).whenReady(), {
    message: /empty weblet formula id/,
  });
});

// ---- store-interaction log assertions ----------------------------------

test('makeFormulaBackedAppsNameHub calls listBindings exactly once at construction', async t => {
  // Regression: a refactor that re-hydrates on every method call
  // would multiply DB reads. The hydration runs once.
  const fake = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await E(apps).whenReady();
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  await E(apps).has('chat.example.com');
  await E(apps).lookup('chat.example.com');
  const listCalls = fake.log.filter(entry => entry[0] === 'list').length;
  t.is(listCalls, 1);
});

test('makeFormulaBackedAppsNameHub writeBinding is not called for an idempotent rebind to the same id... actually it is', async t => {
  // Document the chosen behavior: the hub does call writeBinding
  // again even when the in-memory map already has the same value.
  // This lets a store that tracks revisions update its timestamp,
  // and keeps the hub's logic simple. If a future change wants to
  // suppress duplicate writes, this assertion flips.
  const fake = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  await E(apps).bind('chat.example.com', 'weblet-id-abc');
  const writeCalls = fake.log.filter(entry => entry[0] === 'write').length;
  t.is(writeCalls, 2);
});

test('makeFormulaBackedAppsNameHub deleteBinding still runs for an unbound unbind', async t => {
  // Per the design's contract: the hub forwards the delete request
  // so a store that has an out-of-band entry can also remove it.
  const fake = makeFakeStore();
  const apps = makeFormulaBackedAppsNameHub({ formulaStore: fake.store });
  await E(apps).unbind('chat.example.com');
  const deletes = fake.log.filter(entry => entry[0] === 'delete');
  t.is(deletes.length, 1);
  t.is(deletes[0][1], 'chat.example.com');
});
