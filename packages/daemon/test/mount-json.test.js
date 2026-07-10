// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { E } from '@endo/eventual-send';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import { makeMount, makeRevocableMount } from '../src/mount.js';
import { buildMountFixture } from './_mount-fixture.js';

const jsonCasesUrl = new URL('./mount-json-cases.json', import.meta.url);

const filePowers = makeFilePowers({ fs, path });

/**
 * The JSON read variant coverage matrix, shared verbatim with a future
 * Rust/XS-side runner. Each case pins the exact `readJson` / `maybeReadJson`
 * outcome over the canonical mount fixture; a discrepancy is either a Node
 * regression or a cross-language parity break.
 */
const { cases } = JSON.parse(fs.readFileSync(jsonCasesUrl, 'utf8'));

test('JSON read case table over the shared fixture (Rust/Node parity contract)', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  await null;
  let ran = 0;
  for (const testCase of cases) {
    const { name, method, path: casePath } = testCase;
    if (testCase.expectThrows) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(() => E(mount)[method](casePath), undefined, name);
    } else if (testCase.expectUndefined) {
      // eslint-disable-next-line no-await-in-loop
      const result = await E(mount)[method](casePath);
      t.is(result, undefined, name);
    } else {
      // eslint-disable-next-line no-await-in-loop
      const result = await E(mount)[method](casePath);
      t.deepEqual(result, testCase.expect, name);
    }
    ran += 1;
  }
  // Guard against a silently-empty table or a broken loop reporting green.
  t.true(ran >= 6, `expected the matrix to exercise many cases, ran ${ran}`);
});

test('readJson round-trips a nested value written by writeJson', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  const value = harden({
    name: 'round-trip',
    count: 3,
    nested: { flag: false, list: ['a', 'b'], deeper: { n: null } },
  });
  await E(mount).writeJson('written.json', value);
  const back = await E(mount).readJson('written.json');
  t.deepEqual(back, value, 'the parsed value equals the value written');
});

test('writeJson formats with a 2-space indent and a trailing newline', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  await E(mount).writeJson('formatted.json', harden({ a: 1, b: [2, 3] }));
  // Read the raw bytes back through readText to pin the exact serialization,
  // not just its parsed shape.
  const text = await E(mount).readText('formatted.json');
  t.is(
    text,
    '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n',
    'two-space indent plus exactly one trailing newline',
  );
  t.true(text.endsWith('}\n'), 'ends with a single trailing newline');
});

test('writeJson creates parent directories via path segments', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  // A string path is a single name; nested writes use the path-segments form,
  // exercising the `makePath(parent)` directory creation.
  await E(mount).writeJson(['sub', 'deep', 'file.json'], harden({ ok: true }));
  const back = await E(mount).readJson(['sub', 'deep', 'file.json']);
  t.deepEqual(back, { ok: true });
});

test('writeJson throws on non-serializable input and writes nothing', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  // `JSON.stringify(undefined)` is `undefined`; writeJson must reject rather
  // than persisting the literal string "undefined". Use a *nested* target whose
  // parent directory does not yet exist, so the assertion pins the ordering the
  // changeset advertises — the serializability guard runs BEFORE `makePath`, not
  // just before the write. A guard placed after `makePath` would leave `fresh/`
  // behind even though no file was written; a top-level target (whose parent,
  // the root, already exists) could not tell the two orderings apart.
  await t.throwsAsync(
    () => E(mount).writeJson(['fresh', 'nope.json'], undefined),
    { message: /not JSON-serializable/ },
  );
  t.false(
    fs.existsSync(path.join(root, 'fresh')),
    'the parent directory is not created when the value is rejected',
  );
  // The guard runs before any file is created, so the target never appears and
  // `readJson` still reports it missing.
  await t.throwsAsync(() => E(mount).readJson(['fresh', 'nope.json']));
  t.is(
    await E(mount).maybeReadJson(['fresh', 'nope.json']),
    undefined,
    'no "undefined"-bearing file was left behind',
  );
});

test('writeJson throws on a value JSON.stringify cannot serialize (circular)', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  // A circular value makes `JSON.stringify` *throw* (rather than return
  // `undefined`); writeJson lets that throw propagate — it still fails closed,
  // leaving no filesystem trace, exactly as the undefined-return path does.
  const circular = { name: 'loop' };
  circular.self = circular;
  await t.throwsAsync(() => E(mount).writeJson(['loop', 'x.json'], circular));
  t.false(
    fs.existsSync(path.join(root, 'loop')),
    'a value that cannot be serialized leaves nothing behind',
  );
});

test('maybeReadJson of a present file holding literal null returns null, not undefined', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  // The contract's load-bearing distinction: `undefined` means *absent*, while a
  // present file holding the JSON value `null` (a real, falsy payload) must come
  // back as `null`. Confusing the two would make an intentionally-null document
  // indistinguishable from a missing one.
  await E(mount).writeJson('null-doc.json', harden(null));
  t.is(await E(mount).readJson('null-doc.json'), null);
  t.is(await E(mount).maybeReadJson('null-doc.json'), null);
  t.is(await E(mount).maybeReadJson('absent.json'), undefined);
});

test('readJson of a present-but-empty file throws (empty string is not JSON)', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  // `JSON.parse('')` throws; an empty file is a present-but-invalid boundary
  // distinct from notes.txt's non-empty invalid content. `readJson` throws and
  // `maybeReadJson` still throws (the parse sits outside the read's catch).
  await E(mount).writeText('empty.json', '');
  await t.throwsAsync(() => E(mount).readJson('empty.json'));
  await t.throwsAsync(() => E(mount).maybeReadJson('empty.json'));
});

test('maybeReadJson of a present-but-invalid file throws while a missing file is undefined', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  // notes.txt is present but not valid JSON: the parse sits outside the read's
  // catch, so it throws rather than masquerading as an absent (undefined) file.
  await t.throwsAsync(() => E(mount).maybeReadJson('notes.txt'));
  t.is(await E(mount).maybeReadJson('absent.json'), undefined);
});

test('the JSON methods refuse a path escaping confinement', async t => {
  const { root, created } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  // The fixture's `escape` symlink points at `../escape-target`, a real sibling
  // directory materialized *above* the mount root; reaching through it leaves
  // confinement. The symlink is `optional: true` (some platforms cannot create
  // it), so gate on the fixture actually having built it — but confinement is
  // the headline security contract of these methods, so pin it whenever we can.
  if (!created.has('escape')) {
    t.pass('platform could not create the escaping symlink; skipping');
    return;
  }

  // Plant a *valid* JSON document outside the mount, reachable through the
  // escape symlink. This is what makes the assertions load-bearing: were the
  // confinement gate removed, `readJson` would parse this file and *succeed*
  // (and `maybeReadJson` would return its value) rather than throw — so the
  // throw / `undefined` outcomes below prove the gate, not an incidental parse
  // failure. (The fixture's own `escape-target/secret.txt` is not JSON, so it
  // would throw on the parse regardless and could not witness confinement.)
  const escapeTarget = path.join(path.dirname(root), 'escape-target');
  fs.writeFileSync(
    path.join(escapeTarget, 'reachable.json'),
    '{ "outside": true }\n',
  );

  // readJson must throw (confinement is gated before the read, exactly as
  // readText); maybeReadJson must fold the escape into its `undefined` envelope
  // (the assertConfined failure lands inside the read's catch).
  await t.throwsAsync(() => E(mount).readJson(['escape', 'reachable.json']));
  t.is(await E(mount).maybeReadJson(['escape', 'reachable.json']), undefined);

  // writeJson must refuse to write through the escape, leaving no file outside
  // the mount. Verify the host filesystem above the root is untouched.
  await t.throwsAsync(() =>
    E(mount).writeJson(['escape', 'injected.json'], harden({ hacked: true })),
  );
  t.false(
    fs.existsSync(path.join(escapeTarget, 'injected.json')),
    'no file is written outside the mount root',
  );
});

test('writeJson on a read-only mount throws before touching the filesystem', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: true, filePowers });

  await t.throwsAsync(() => E(mount).writeJson('ro.json', harden({ a: 1 })));
  t.false(
    fs.existsSync(path.join(root, 'ro.json')),
    'a read-only mount writes nothing',
  );
});

test('writeJson on a revoked mount throws', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-json-revoke-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  const { mount, control } = makeRevocableMount({
    rootPath: root,
    readOnly: false,
    filePowers,
  });
  await E(mount).writeJson('live.json', harden({ live: true }));
  t.deepEqual(await E(mount).readJson('live.json'), { live: true });

  E(control).revoke();

  await t.throwsAsync(
    () => E(mount).writeJson('live.json', harden({ live: false })),
    {
      message: /Mount has been revoked/,
    },
  );
});
