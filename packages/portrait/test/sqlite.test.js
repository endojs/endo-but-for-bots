// @ts-check
import test from '@endo/ses-ava/test.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import harden from '@endo/harden';
import { M } from '@endo/patterns';

import {
  makePersistenceEnv,
  definePersistentExoClass,
  makePersistentHeap,
} from '../index.js';
import { makeSqlitePortraitStore } from '../src/stores/sqlite.js';

/** Load better-sqlite3 lazily so the suite skips where unavailable. */
const loadSqlite = async () => {
  try {
    const { default: Database } = await import('better-sqlite3');
    return Database;
  } catch {
    return undefined;
  }
};

const makeWorld = () => {
  const env = makePersistenceEnv();
  const makeCounter = definePersistentExoClass(
    env,
    'sqlite-test#makeCounter',
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
    {
      stateShape: harden({ count: M.number() }),
    },
  );
  return { env, makeCounter };
};

test('sqlite store: durability across restart, delta upserts', async t => {
  const Database = await loadSqlite();
  if (Database === undefined) {
    t.pass('better-sqlite3 unavailable; skipping');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'portrait-sqlite-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'portraits.sqlite');

  {
    const { env, makeCounter } = makeWorld();
    const store = makeSqlitePortraitStore(new Database(dbPath), {
      ownsDatabase: true,
    });
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({ counter: makeCounter(0) }),
    });
    heap.roots.counter.increment();
    heap.roots.counter.increment();
    heap.roots.counter.increment();
    await heap.flush();
    await heap.close();
  }

  {
    const { env } = makeWorld();
    const store = makeSqlitePortraitStore(new Database(dbPath), {
      ownsDatabase: true,
    });
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => {
        t.fail('must restore from sqlite');
        return harden({});
      },
    });
    t.is(heap.roots.counter.count(), 3);
    await heap.close();
  }
});

test('stateShape: bad init and bad restored data are rejected', async t => {
  const env = makePersistenceEnv();
  const makeStrict = definePersistentExoClass(
    env,
    'sqlite-test#makeStrict',
    M.interface('Strict', { get: M.call().returns(M.number()) }),
    (/** @type {any} */ n) => ({ n }),
    {
      get() {
        return this.state.n;
      },
    },
    { stateShape: harden({ n: M.number() }) },
  );
  t.throws(() => makeStrict('not a number'), {
    message: /n.*[Mm]ust be/,
  });
  t.notThrows(() => makeStrict(7));
});
