// @ts-check
import test from '@endo/ses-ava/test.js';

import { mkdtemp, rm, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import harden from '@endo/harden';
import { M } from '@endo/patterns';

import {
  makePersistenceEnv,
  definePersistentExoClass,
  makePersistentHeap,
  makeFilePortraitStore,
  makeMemoryPortraitStore,
} from '../index.js';

const fsPowers = harden({ readFile, writeFile, rename });

const makeWorld = () => {
  const env = makePersistenceEnv();
  const makeCounter = definePersistentExoClass(
    env,
    'stores-test#makeCounter',
    M.interface('Counter', {
      increment: M.call().returns(M.number()),
      count: M.call().returns(M.number()),
    }),
    (start = 0) => ({ count: start }),
    {
      increment() {
        this.state.count += 1;
        return this.state.count;
      },
      count() {
        return this.state.count;
      },
    },
  );
  return { env, makeCounter };
};

test('file store: atomic persistence across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'portrait-file-store-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'heap.json');

  {
    const { env, makeCounter } = makeWorld();
    const store = await makeFilePortraitStore(path, fsPowers);
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({ counter: makeCounter(0) }),
    });
    heap.roots.counter.increment();
    heap.roots.counter.increment();
    await heap.flush();
    await heap.close();
  }

  {
    const { env } = makeWorld();
    const store = await makeFilePortraitStore(path, fsPowers);
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => {
        t.fail('must restore from file');
        return harden({});
      },
    });
    t.is(heap.roots.counter.count(), 2);
    await heap.close();
  }

  const text = await readFile(path, 'utf8');
  const parsed = JSON.parse(text);
  t.is(parsed.formatVersion, 1);
  t.is(Object.keys(parsed.portraits).length, 1);
});

test('memory store: generations replay to any point', async t => {
  const { env, makeCounter } = makeWorld();
  const store = makeMemoryPortraitStore();
  const heap = await makePersistentHeap({
    env,
    store,
    persistOn: 'manual',
    spawnRoots: () => harden({ counter: makeCounter(0) }),
  });
  heap.roots.counter.increment();
  await heap.flush();
  heap.roots.counter.increment();
  await heap.flush();

  const generations = store.getGenerations();
  t.is(generations.length, 3, 'initial graph + two deltas');
  t.is(generations[0].type, 'graph');
  t.is(generations[1].type, 'delta');

  // Time travel: restore a fresh world from generation 1 (count === 1).
  const { env: env2 } = makeWorld();
  const pastGraph = store.graphAtGeneration(1);
  const pastStore = makeMemoryPortraitStore();
  await pastStore.saveGraph(/** @type {any} */ (pastGraph));
  const pastHeap = await makePersistentHeap({
    env: env2,
    store: pastStore,
    spawnRoots: () => harden({}),
  });
  t.is(pastHeap.roots.counter.count(), 1);
  await pastHeap.close();
  await heap.close();
});
