// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { looksLikeReadableBlob } from '../src/fs/interfaces.js';

// `looksLikeReadableBlob` is the single exported discriminator shared by every
// consumer that must tell a drainable readable blob from a writer, a generic
// reader, or an `HttpResponse` by method name alone. Two of those consumers —
// `daemon/src/mount.js`'s `write()` and `daemon/src/host.js`'s
// `materializeTree`/`stageTree` — reach it on the `kind()`-less fallback path,
// where a source tree that does not advertise the `kind` protocol classifies
// each child purely by its method names. `mount.test.js` covers the `write()`
// call site through a real mount; this pins the discriminator itself so that
// weakening it back to a bare `methodNames.includes('stream')` check (the shape
// before the byte-stream consolidation, when `streamBase64` was unambiguous)
// fails a test rather than silently mis-admitting a non-blob at any call site.

test('admits the canonical text-bearing ReadableBlob', t => {
  // `blobFromBytes`, an `@endo/exo-unzip` leaf, `makeBrowserBlob`.
  t.true(looksLikeReadableBlob(['help', 'stream', 'text', 'json']));
});

test('admits a content-addressed blob carrying getInfo', t => {
  // A `BlobRef`-style byte-stream-only blob (no whole-value `text`).
  t.true(looksLikeReadableBlob(['stream', 'getInfo']));
});

test('admits a raw PassableBytesReader carrying readReturnPattern', t => {
  t.true(looksLikeReadableBlob(['stream', 'readReturnPattern']));
});

test('rejects a value advertising only the generic stream method', t => {
  // The exact regression this discriminator exists to prevent: `stream` alone
  // no longer discriminates, so a bare-`stream` value must not be mistaken for
  // a drainable blob.
  t.false(looksLikeReadableBlob(['stream']));
  t.false(looksLikeReadableBlob(['help', 'stream']));
});

test('rejects a generic PassableReader that also carries readPattern', t => {
  // A generic value reader advertises `stream` + `readReturnPattern` like a
  // bytes reader, but it also carries `readPattern` (its yields are arbitrary
  // Passables, not bytes), which excludes it.
  t.false(
    looksLikeReadableBlob(['stream', 'readReturnPattern', 'readPattern']),
  );
});

test('rejects a writer', t => {
  // A `PassableBytesWriter` carries `stream` + `writePattern` /
  // `writeReturnPattern` but no read marker, so it falls through both branches.
  t.false(
    looksLikeReadableBlob(['stream', 'writePattern', 'writeReturnPattern']),
  );
});

test('rejects an HttpResponse, which exposes its body under body() not stream', t => {
  // An `@endo/exo-http-client` `HttpResponse` carries `text`/`json`/`status`
  // and exposes its byte reader as `body()`, never `stream`, so it fails the
  // top-level `stream` check with no `HttpResponse`-specific clause.
  t.false(
    looksLikeReadableBlob([
      'status',
      'statusText',
      'ok',
      'headers',
      'url',
      'text',
      'json',
      'body',
      'help',
    ]),
  );
});

test('rejects a value with no stream method at all', t => {
  t.false(looksLikeReadableBlob([]));
  t.false(looksLikeReadableBlob(['text', 'json']));
  t.false(looksLikeReadableBlob(['getInfo', 'fetch', 'text', 'json', 'help']));
});
