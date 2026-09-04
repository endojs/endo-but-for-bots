import test from '@endo/ses-ava/prepare-endo.js';

import { encodeUtf8 } from '@endo/utf8/encode.js';

import { makeMemoryCasStore, makeRetentionLinkSet } from '../src/store.js';
import { sha256HexWebCrypto } from '../src/store-web-powers.js';

test('sha256HexWebCrypto computes the SHA-256 hex digest of bytes', async t => {
  // Known vector: SHA-256 of empty bytes.
  const empty = await sha256HexWebCrypto(new Uint8Array());
  t.is(
    empty,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  // Known vector: SHA-256 of "abc".
  const abc = await sha256HexWebCrypto(encodeUtf8('abc'));
  t.is(abc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('memory CAS round-trips bytes by content hash', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const bytes = encodeUtf8('package contents');
  const hash = await cas.write(bytes);
  t.true(await cas.has(hash));
  const read = await cas.read(hash);
  t.deepEqual(Array.from(read), Array.from(bytes));
});

test('memory CAS is content-addressed: identical writes return identical hashes', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const bytes = encodeUtf8('idempotent');
  const h1 = await cas.write(bytes);
  const h2 = await cas.write(encodeUtf8('idempotent'));
  t.is(h1, h2);
  const list = await cas.list();
  // Only one entry despite two writes.
  t.is(list.length, 1);
  t.is(list[0], h1);
});

test('memory CAS read on unknown hash throws', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  await t.throwsAsync(() => cas.read('cafebabe'), {
    message: /no entry for hash .*cafebabe/,
  });
});

test('memory CAS evict drops the entry and reports true', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const hash = await cas.write(encodeUtf8('evictable'));
  const evicted = await cas.evict(hash);
  t.true(evicted);
  t.false(await cas.has(hash));
});

test('memory CAS evict on missing hash returns false', async t => {
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const evicted = await cas.evict('deadbeef');
  t.false(evicted);
});

test('memory CAS evict respects retention pins (hard retention link)', async t => {
  // This is the design's load-bearing invariant from § Caching and
  // retention: "anything reachable from a captured formula graph
  // holds a hard retention link that prevents eviction".
  const cas = makeMemoryCasStore({ sha256: sha256HexWebCrypto });
  const hash = await cas.write(encodeUtf8('pinned-by-formula-graph'));
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
  const cas = makeMemoryCasStore({
    sha256: sha256HexWebCrypto,
    retentionLinks: links,
  });
  const hash = await cas.write(encodeUtf8('externally-pinned'));
  // Pin via the externally-held links handle, not via cas.retentionLinks.
  links.pin(hash);
  t.false(await cas.evict(hash));
  links.unpin(hash);
  t.true(await cas.evict(hash));
});

test('makeMemoryCasStore requires a sha256 power', t => {
  // The store deliberately does not bind to a platform-specific
  // crypto primitive; callers wire the power in. Omitting it must
  // fail loudly rather than silently fall back to a global.
  t.throws(
    // @ts-expect-error intentional misuse
    () => makeMemoryCasStore({}),
    { message: /requires a sha256 power/ },
  );
  t.throws(
    // @ts-expect-error intentional misuse
    () => makeMemoryCasStore(),
    { message: /requires a sha256 power/ },
  );
});

test('memory CAS uses the caller-supplied sha256 power', async t => {
  // The decoupling is observable: a caller can supply a stub digest
  // and the store will use it. This guards against a regression that
  // re-binds the store to a global crypto primitive.
  let calls = 0;
  /** @param {Uint8Array} _bytes */
  const stubSha256 = async _bytes => {
    calls += 1;
    return 'stub-hash';
  };
  const cas = makeMemoryCasStore({ sha256: stubSha256 });
  const hash = await cas.write(encodeUtf8('whatever'));
  t.is(hash, 'stub-hash');
  t.is(calls, 1);
});
