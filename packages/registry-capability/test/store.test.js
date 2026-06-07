import test from '@endo/ses-ava/prepare-endo.js';

import { bytesFromText } from '@endo/bytes/from-string.js';

import {
  makeMemoryCasStore,
  sha256Hex,
  makeRetentionLinkSet,
} from '../src/store.js';

test('sha256Hex computes the SHA-256 hex digest of bytes', async t => {
  // Known vector: SHA-256 of empty bytes.
  const empty = await sha256Hex(new Uint8Array());
  t.is(
    empty,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  // Known vector: SHA-256 of "abc".
  const abc = await sha256Hex(bytesFromText('abc'));
  t.is(abc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('memory CAS round-trips bytes by content hash', async t => {
  const cas = makeMemoryCasStore();
  const bytes = bytesFromText('package contents');
  const hash = await cas.write(bytes);
  t.true(await cas.has(hash));
  const read = await cas.read(hash);
  t.deepEqual(Array.from(read), Array.from(bytes));
});

test('memory CAS is content-addressed: identical writes return identical hashes', async t => {
  const cas = makeMemoryCasStore();
  const bytes = bytesFromText('idempotent');
  const h1 = await cas.write(bytes);
  const h2 = await cas.write(bytesFromText('idempotent'));
  t.is(h1, h2);
  const list = await cas.list();
  // Only one entry despite two writes.
  t.is(list.length, 1);
  t.is(list[0], h1);
});

test('memory CAS read on unknown hash throws', async t => {
  const cas = makeMemoryCasStore();
  await t.throwsAsync(() => cas.read('cafebabe'), {
    message: /no entry for hash .*cafebabe/,
  });
});

test('memory CAS evict drops the entry and reports true', async t => {
  const cas = makeMemoryCasStore();
  const hash = await cas.write(bytesFromText('evictable'));
  const evicted = await cas.evict(hash);
  t.true(evicted);
  t.false(await cas.has(hash));
});

test('memory CAS evict on missing hash returns false', async t => {
  const cas = makeMemoryCasStore();
  const evicted = await cas.evict('deadbeef');
  t.false(evicted);
});

test('memory CAS evict respects retention pins (hard retention link)', async t => {
  // This is the design's load-bearing invariant from § Caching and
  // retention: "anything reachable from a captured formula graph
  // holds a hard retention link that prevents eviction".
  const cas = makeMemoryCasStore();
  const hash = await cas.write(bytesFromText('pinned-by-formula-graph'));
  cas.retentionLinks.pin(hash);
  const evicted = await cas.evict(hash);
  t.false(evicted, 'evict must return false while pinned');
  t.true(await cas.has(hash), 'bytes must remain after a pinned evict');
  cas.retentionLinks.unpin(hash);
  t.true(await cas.evict(hash), 'evict must succeed after unpin');
  t.false(await cas.has(hash));
});

test('retention link set tracks pins independently', t => {
  const links = makeRetentionLinkSet();
  t.false(links.isPinned('a'));
  links.pin('a');
  t.true(links.isPinned('a'));
  links.unpin('a');
  t.false(links.isPinned('a'));
  // Double-unpin is a no-op.
  links.unpin('a');
  t.false(links.isPinned('a'));
});

test('makeMemoryCasStore accepts a caller-supplied retention link set', async t => {
  // Layer 3 (snapshot-mapper) supplies its own retention links wired
  // into the formula graph; the store must honor a caller-supplied
  // implementation rather than always allocating its own.
  const links = makeRetentionLinkSet();
  const cas = makeMemoryCasStore({ retentionLinks: links });
  const hash = await cas.write(bytesFromText('externally-pinned'));
  // Pin via the externally-held links handle, not via cas.retentionLinks.
  links.pin(hash);
  t.false(await cas.evict(hash));
  links.unpin(hash);
  t.true(await cas.evict(hash));
});
