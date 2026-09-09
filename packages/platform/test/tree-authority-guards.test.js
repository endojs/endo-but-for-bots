// @ts-check
/* eslint-disable no-underscore-dangle */

import test from '@endo/ses-ava/prepare-endo.js';
import { makeExo } from '@endo/exo';

import {
  EnumerableTreeInterface,
  LookupTreeInterface,
  ReadableTreeInterface,
} from '../src/fs/interfaces.js';

const lookupMethods = harden({
  help: () => 'lookup tree',
  has: async () => false,
  lookup: async () => undefined,
});

test('lookup tree withholds enumeration authority', t => {
  const lookupTree = makeExo(
    'TestLookupTree',
    LookupTreeInterface,
    lookupMethods,
  );
  t.false('__getMethodNames__' in lookupMethods);
  t.deepEqual(/** @type {any} */ (lookupTree).__getMethodNames__(), [
    '__getInterfaceGuard__',
    '__getMethodNames__',
    'has',
    'help',
    'lookup',
  ]);
  const error = t.throws(() => /** @type {any} */ (lookupTree).list());
  t.true(error instanceof TypeError);
});

test('enumerable and readable trees retain the historical read surface', t => {
  const enumerableMethods = harden({
    ...lookupMethods,
    list: async () => harden([]),
  });
  const enumerableTree = makeExo(
    'TestEnumerableTree',
    EnumerableTreeInterface,
    enumerableMethods,
  );
  t.deepEqual(/** @type {any} */ (enumerableTree).__getMethodNames__(), [
    '__getInterfaceGuard__',
    '__getMethodNames__',
    'has',
    'help',
    'list',
    'lookup',
  ]);

  const readableTree = makeExo('TestReadableTree', ReadableTreeInterface, {
    ...enumerableMethods,
    listTree: async () => harden([]),
  });
  t.true(
    /** @type {any} */ (readableTree).__getMethodNames__().includes('list'),
  );
  t.true(
    /** @type {any} */ (readableTree).__getMethodNames__().includes('lookup'),
  );
});
