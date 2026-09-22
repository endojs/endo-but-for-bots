// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeNativeProducerStore } from '../src/native-producer-store.js';
import { makeNativeProducerLifecycle } from '../src/native-producer-lifecycle.js';

const manifest = harden({
  version: /** @type {const} */ (1),
  sessionId: 'session',
  ownerId: 'owner',
  incarnation: 'incarnation',
  releaseId: 'release',
  roles: ['sandbox'],
  adapterRef: 'opaque',
});
/** @param {string} revision */
const record = revision =>
  harden({
    revision,
    manifest,
    phase: /** @type {const} */ ('active'),
    admissions: [],
  });

/** @param {import('ava').ExecutionContext} t */
const fixture = async t => {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'producer-store-'));
  t.teardown(() => fs.rm(temporary, { recursive: true, force: true }));
  const directory = join(await fs.realpath(temporary), 'records');
  await fs.mkdir(directory, { mode: 0o700 });
  return {
    directory,
    open: () => makeNativeProducerStore({ directory, manifest }),
  };
};

test('real append store persists across reconstruction and rejects stale/gapped writes', async t => {
  const f = await fixture(t);
  const store = await f.open();
  await store.compareAndAppend(undefined, record('0'));
  await (await f.open()).compareAndAppend('0', record('1'));
  t.deepEqual(await store.read(), record('1'));
  await t.throwsAsync(store.compareAndAppend('0', record('1')), {
    message: /conflict/,
  });
  await t.throwsAsync(store.compareAndAppend('1', record('3')), {
    message: /identity changed/,
  });
});

test('two independent writers cannot publish the same successor', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.open(), f.open()]);
  const results = await Promise.allSettled([
    a.compareAndAppend(undefined, record('0')),
    b.compareAndAppend(undefined, record('0')),
  ]);
  t.is(results.filter(result => result.status === 'fulfilled').length, 1);
  t.deepEqual(await a.read(), record('0'));
});

test('lost publication flush acknowledgement is recovered and flushed on read', async t => {
  const f = await fixture(t);
  let fail = false;
  let flushes = 0;
  const store = await makeNativeProducerStore(
    { directory: f.directory, manifest },
    {
      syncDirectory: async path => {
        flushes += 1;
        if (fail) throw Error('fsync failed');
        const handle = await fs.open(path, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    },
  );
  // Fail only after publication, not the read which precedes it.
  const injected = {
    ...fs,
    link: async (from, to) => {
      await fs.link(from, to);
      fail = true;
    },
  };
  const writing = await makeNativeProducerStore(
    { directory: f.directory, manifest },
    {
      fs: injected,
      syncDirectory: async () => {
        if (fail) throw Error('fsync failed');
      },
    },
  );
  await t.throwsAsync(writing.compareAndAppend(undefined, record('0')), {
    message: /fsync failed/,
  });
  fail = false;
  const before = flushes;
  t.deepEqual(await store.read(), record('0'));
  t.true(flushes > before);
});

test('orphan staging does not publish an incarnation; unknown files and revision gaps fail closed', async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.directory, '.pending-orphan'), 'partial');
  const store = await f.open();
  t.is(await store.read(), undefined);
  await fs.writeFile(
    join(f.directory, 'revision-1.json'),
    JSON.stringify(record('1')),
  );
  await t.throwsAsync(store.read(), { message: /revision gap/ });
  t.is(
    await fs.readFile(join(f.directory, '.pending-orphan'), 'utf8'),
    'partial',
  );
});

test('directory or record symlink substitution is refused', async t => {
  const f = await fixture(t);
  const store = await f.open();
  await store.compareAndAppend(undefined, record('0'));
  const old = `${f.directory}-old`;
  await fs.rename(f.directory, old);
  await fs.symlink(old, f.directory);
  await t.throwsAsync(store.read(), { message: /directory identity changed/ });
  await t.throwsAsync(f.open(), { message: /symlinks/ });
});

test('real store retirement receipt survives a new lifecycle instance', async t => {
  const f = await fixture(t);
  const proof = harden({ manifest, evidence: 'exact-resource-proof' });
  let stops = 0;
  const adapter = {
    async admit() {
      return undefined;
    },
    async fenceAndStop() {
      stops += 1;
      return proof;
    },
    async reconcile() {
      return proof;
    },
  };
  const owner = makeNativeProducerLifecycle({
    manifest,
    adapter,
    store: await f.open(),
  });
  await owner.initialize();
  await owner.admit('sandbox', 'one', {});
  await owner.retire();
  const recovered = makeNativeProducerLifecycle({
    manifest,
    adapter,
    store: await f.open(),
  });
  t.deepEqual(await recovered.retire(), proof);
  await t.throwsAsync(recovered.initialize(), { message: /retiring/ });
  t.is(stops, 1);
});

test('terminal state cannot be reverted or new admissions added after durable fence', async t => {
  const f = await fixture(t);
  const store = await f.open();
  await store.compareAndAppend(undefined, record('0'));
  await store.compareAndAppend('0', { ...record('1'), phase: 'retiring' });
  await t.throwsAsync(store.compareAndAppend('1', record('2')), {
    message: /lifecycle transition/,
  });
  await t.throwsAsync(
    store.compareAndAppend('1', {
      ...record('2'),
      phase: 'stopped',
      shutdown: { manifest, evidence: 'proof' },
      admissions: [{ role: 'sandbox', operationId: 'late' }],
    }),
    { message: /admission after fence/ },
  );
});

test('record leaf symlink and mismatched immutable identity are rejected', async t => {
  const f = await fixture(t);
  const store = await f.open();
  await t.throwsAsync(
    store.compareAndAppend(undefined, {
      ...record('0'),
      manifest: { ...manifest, ownerId: 'other' },
    }),
    { message: /identity changed/ },
  );
  const target = join(f.directory, '.pending-target');
  await fs.writeFile(target, JSON.stringify(record('0')));
  await fs.symlink(target, join(f.directory, 'revision-0.json'));
  await t.throwsAsync(store.read(), { code: 'ELOOP' });
});

test('store bounds identity, operation IDs, revisions, and record reads', async t => {
  const f = await fixture(t);
  await t.throwsAsync(
    makeNativeProducerStore({
      directory: f.directory,
      manifest: { ...manifest, incarnation: 'x'.repeat(1025) },
    }),
    { message: /Invalid producer identity/ },
  );
  const store = await f.open();
  await store.compareAndAppend(undefined, record('0'));
  await t.throwsAsync(
    store.compareAndAppend('0', {
      ...record('1'),
      admissions: [{ role: 'sandbox', operationId: 'x'.repeat(1025) }],
    }),
    { message: /Invalid producer identity/ },
  );
  await t.throwsAsync(store.compareAndAppend('9'.repeat(65), record('1')), {
    message: /Invalid producer store revision/,
  });
  const file = join(f.directory, 'revision-1.json');
  await fs.writeFile(file, '');
  await fs.truncate(file, 8 * 1024 * 1024 + 1);
  await t.throwsAsync(store.read(), { message: /size limit/ });
});
