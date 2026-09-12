// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makePromiseKit } from '@endo/promise-kit';

import { makeDirectoryMaker } from '../src/directory.js';
import { makeFormulaGraph } from '../src/graph.js';

/** @import { EndoDirectory, FormulaIdentifier, NodeNumber, StoreController } from '../src/types.js' */

/** @param {string} name */
const idFor = name => /** @type {FormulaIdentifier} */ (`${name}:node`);

/**
 * @param {(name: string) => Promise<void>} publish
 * @param {() => Promise<void>} [cleanup]
 */
const setup = (publish, cleanup = async () => {}) => {
  /** @type {FormulaIdentifier[]} */
  const created = [];
  /** @type {FormulaIdentifier[]} */
  const collected = [];
  const graph = makeFormulaGraph({
    extractLabeledDeps: formula =>
      formula.type === 'directory' ? [['petStore', formula.petStore]] : [],
    isLocalId: () => true,
    onCollect: ids => collected.push(...ids),
  });
  const parentId = idFor('parent');
  graph.onFormulaAdded(parentId, { type: 'pet-store' });
  graph.addRoot(parentId);
  const unavailable = () => {
    throw Error('Unexpected directory fixture operation');
  };
  const { makeDirectoryNode } = makeDirectoryMaker({
    provide: unavailable,
    provideStoreController: unavailable,
    getIdForRef: unavailable,
    getTypeForId: unavailable,
    getContentIdentityForId: unavailable,
    formulateReadableBlob: unavailable,
    formulateDirectory: async () => {
      const id = idFor(`directory-${created.length}`);
      const petStore = idFor(`store-${created.length}`);
      graph.onFormulaAdded(petStore, { type: 'pet-store' });
      graph.onFormulaAdded(id, { type: 'directory', petStore });
      graph.pinTransient(id);
      created.push(id);
      return {
        id,
        value: /** @type {EndoDirectory} */ (
          /** @type {unknown} */ (harden({}))
        ),
      };
    },
    unpinTransient: async id => {
      graph.unpinTransient(id);
      await cleanup();
    },
  });
  // This fixture supplies only the controller method exercised by creation.
  const controller = /** @type {StoreController} */ (
    /** @type {unknown} */ ({
      /**
       * @param {string} name
       * @param {FormulaIdentifier} id
       */
      storeIdentifier: async (name, id) => {
        await publish(name);
        graph.onPetStoreWrite(parentId, id);
      },
    })
  );
  const directory = makeDirectoryNode(
    controller,
    /** @type {NodeNumber} */ ('node'),
    () => true,
    async () => [],
    async () => [],
  );
  return { directory, graph, parentId, created, collected };
};

test('directory creation retains its transferred pin during concurrent publication', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  const proceed = makePromiseKit();
  const f = setup(async name => {
    await null;
    if (name === 'held') {
      entered.resolve(undefined);
      await proceed.promise;
    }
  });
  const held = f.directory.makeDirectory('held');
  await entered.promise;
  await f.directory.makeDirectory('sibling');
  const [heldId, siblingId] = f.created;
  f.graph.onPetStoreRemove(f.parentId, siblingId);
  t.true(f.collected.includes(siblingId));
  f.graph.sweepUnreachable();
  t.false(f.collected.includes(heldId));

  proceed.resolve(undefined);
  await held;
  t.false(f.collected.includes(heldId));
  f.graph.onPetStoreRemove(f.parentId, heldId);
  t.true(f.collected.includes(heldId));
  t.true(f.collected.includes(idFor('store-0')));
  t.true(f.collected.includes(idFor('store-1')));
});

test('failed directory publication releases its pin and awaits collection cleanup', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  const proceed = makePromiseKit();
  const f = setup(
    async () => {
      throw Error('Publication failed');
    },
    async () => {
      entered.resolve(undefined);
      await proceed.promise;
    },
  );
  let settled = false;
  const creation = f.directory.makeDirectory('failure');
  const checked = t.throwsAsync(creation, { message: 'Publication failed' });
  void creation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  t.true(f.collected.includes(f.created[0]));
  t.true(f.collected.includes(idFor('store-0')));
  t.false(settled);
  proceed.resolve(undefined);
  await checked;
});
