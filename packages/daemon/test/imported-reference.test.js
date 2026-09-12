// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeContextMaker } from '../src/context.js';
import { makeImportedReferenceRegistrar } from '../src/imported-reference.js';
import { makeWeakMultimap } from '../src/multimap.js';

/** @import { Context, FormulaIdentifier, WeakMultimap } from '../src/types.js' */

const importedId = /** @type {FormulaIdentifier} */ ('imported:peer');
const aliasId = /** @type {FormulaIdentifier} */ ('alias:peer');

const setup = () => {
  /** @type {WeakMultimap<object, FormulaIdentifier>} */
  const idForRef = makeWeakMultimap();
  /** @type {Map<FormulaIdentifier, object>} */
  const refForId = new Map();
  /** @type {Map<FormulaIdentifier, { context: Context }>} */
  const controllerForId = new Map();
  const makeContext = makeContextMaker({
    controllerForId,
    provideController: id => {
      const controller = controllerForId.get(id);
      if (controller === undefined) throw Error('Missing test controller');
      return controller;
    },
    getFormulaType: () => undefined,
  });
  const register = makeImportedReferenceRegistrar({
    idForRef,
    refForId,
    controllerForId,
  });
  const start = () => {
    const context = makeContext(importedId);
    controllerForId.set(importedId, { context });
    return context;
  };
  return { idForRef, refForId, register, start };
};

test('cancelled imports cannot register late results', async t => {
  const { idForRef, refForId, register, start } = setup();
  const context = start();
  const value = harden({});
  await context.cancel(Error('Cancelled while awaiting peer'));
  register(importedId, value, context);
  t.is(idForRef.get(value), undefined);
  t.false(refForId.has(importedId));
});

test('old cancellation cannot erase a successor with the same presence', async t => {
  const { idForRef, refForId, register, start } = setup();
  const oldContext = start();
  const value = harden({});
  register(importedId, value, oldContext);
  const disposed = oldContext.cancel(Error('Replace imported incarnation'));
  // Context cancellation fences synchronously; its hooks drain later.
  const newContext = start();
  register(importedId, value, newContext);
  await disposed;
  t.is(idForRef.get(value), importedId);
  t.is(refForId.get(importedId), value);
  await newContext.cancel(Error('Finished'));
  t.is(idForRef.get(value), undefined);
  t.false(refForId.has(importedId));
});

test('replacement removes only the old incarnation identity pair', async t => {
  const { idForRef, refForId, register, start } = setup();
  const oldContext = start();
  const oldValue = harden({});
  const newValue = harden({});
  register(importedId, oldValue, oldContext);
  idForRef.add(oldValue, aliasId);
  refForId.set(aliasId, oldValue);
  const disposed = oldContext.cancel(Error('Peer reconnected'));
  const newContext = start();
  register(importedId, newValue, newContext);
  // A still later obsolete result must not overwrite the new maps.
  register(importedId, oldValue, oldContext);
  t.deepEqual(idForRef.getAllFor(oldValue), [aliasId]);
  await disposed;
  t.is(refForId.get(aliasId), oldValue);
  t.is(refForId.get(importedId), newValue);
  t.is(idForRef.get(newValue), importedId);
  await newContext.cancel(Error('Finished'));
  t.is(idForRef.get(newValue), undefined);
  t.is(idForRef.get(oldValue), aliasId);
});

test('registration does not give nested values inferred identities', async t => {
  const { idForRef, refForId, register, start } = setup();
  const context = start();
  const nested = harden({});
  const value = harden({ nested });
  register(importedId, value, context);
  t.is(idForRef.get(value), importedId);
  t.is(idForRef.get(nested), undefined);
  t.is(refForId.get(importedId), value);
  await context.cancel(Error('Finished'));
});
