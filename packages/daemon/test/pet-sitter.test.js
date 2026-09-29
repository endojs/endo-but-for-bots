// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import { makePetSitter } from '../src/pet-sitter.js';

/** @typedef {import('../src/types.js').FormulaIdentifier} FormulaIdentifier */

const id = /** @param {string} s @returns {FormulaIdentifier} */ s =>
  /** @type {FormulaIdentifier} */ (s);

const makeMockController = () => {
  /** @type {Map<string, string>} */
  const entries = new Map();
  return {
    has: name => entries.has(name),
    identifyLocal: name => entries.get(name),
    list: () => harden([...entries.keys()].sort()),
    reverseIdentify: targetId =>
      harden(
        [...entries.entries()]
          .filter(([, v]) => v === targetId)
          .map(([k]) => k),
      ),
    async *followNameChanges() {
      yield* [];
    },
    async *followIdNameChanges(_id) {
      yield harden({ names: [] });
    },
    storeIdentifier: async (name, targetId) => entries.set(name, targetId),
    storeLocator: async (name, locator) => entries.set(name, locator),
    remove: async name => entries.delete(name),
    rename: async (fromName, toName) => {
      const targetId = entries.get(fromName);
      if (targetId === undefined) {
        throw new Error(`Formula does not exist for pet name ${fromName}`);
      }
      entries.delete(fromName);
      entries.set(toName, targetId);
    },
    seedGcEdges: async () => {},
    testEntries: entries,
  };
};

test('has finds special names', t => {
  const ctrl = makeMockController();
  const sitter = makePetSitter(ctrl, { '@agent': id('agent:node') });
  t.true(sitter.has('@agent'));
  t.false(sitter.has('@missing'));
});

test('has delegates to controller for pet names', t => {
  const ctrl = makeMockController();
  ctrl.testEntries.set('myval', id('val:node'));
  const sitter = makePetSitter(ctrl, { '@agent': id('agent:node') });
  t.true(sitter.has('myval'));
  t.false(sitter.has('nope'));
});

test('identifyLocal resolves special names', t => {
  const ctrl = makeMockController();
  const sitter = makePetSitter(ctrl, {
    '@agent': id('agent:node'),
    '@self': id('self:node'),
  });
  t.is(sitter.identifyLocal('@agent'), id('agent:node'));
  t.is(sitter.identifyLocal('@self'), id('self:node'));
});

test('identifyLocal delegates pet names to controller', t => {
  const ctrl = makeMockController();
  ctrl.testEntries.set('foo', id('foo:node'));
  const sitter = makePetSitter(ctrl, { '@agent': id('agent:node') });
  t.is(sitter.identifyLocal('foo'), id('foo:node'));
});

test('identifyLocal throws for name with @ that is not a known special', t => {
  const ctrl = makeMockController();
  const sitter = makePetSitter(ctrl, { '@agent': id('agent:node') });
  // '@unknown' contains '@' so isPetName returns false, and it's not a known special.
  t.throws(() => sitter.identifyLocal('@unknown'), {
    message: /Invalid pet name/,
  });
});

test('list prepends sorted special names', t => {
  const ctrl = makeMockController();
  ctrl.testEntries.set('beta', id('b:node'));
  ctrl.testEntries.set('alpha', id('a:node'));
  const sitter = makePetSitter(ctrl, {
    '@self': id('self:node'),
    '@agent': id('agent:node'),
  });
  const names = sitter.list();
  // Special names sorted first, then controller names.
  t.is(names[0], '@agent');
  t.is(names[1], '@self');
  t.true(names.includes('alpha'));
  t.true(names.includes('beta'));
});

test('reverseIdentify includes special names', t => {
  const ctrl = makeMockController();
  ctrl.testEntries.set('myname', id('target:node'));
  const sitter = makePetSitter(ctrl, { '@agent': id('target:node') });
  const names = sitter.reverseIdentify(id('target:node'));
  t.true(names.includes('myname'));
  t.true(names.includes('@agent'));
});

test('reverseIdentify excludes non-matching special names', t => {
  const ctrl = makeMockController();
  const sitter = makePetSitter(ctrl, { '@agent': id('other:node') });
  const names = sitter.reverseIdentify(id('target:node'));
  t.false(names.includes('@agent'));
});

test('non-extensible sitter preserves existing entries without permitting extension', async t => {
  const controller = makeMockController();
  controller.testEntries.set('first', id('first:node'));
  controller.testEntries.set('second', id('second:node'));
  const sitter = makePetSitter(
    controller,
    { '@agent': id('agent:node') },
    true,
  );

  await sitter.storeIdentifier('first', id('replacement:node'));
  t.is(sitter.identifyLocal('first'), id('replacement:node'));

  await sitter.rename('first', 'second');
  t.false(sitter.has('first'));
  t.is(sitter.identifyLocal('second'), id('replacement:node'));

  await t.throwsAsync(sitter.storeIdentifier('third', id('third:node')), {
    message: 'Cannot add pet name "third" to a non-extensible directory',
  });

  await sitter.remove('second');
  t.false(sitter.has('second'));
  await t.throwsAsync(sitter.storeIdentifier('second', id('again:node')), {
    message: 'Cannot add pet name "second" to a non-extensible directory',
  });
});
