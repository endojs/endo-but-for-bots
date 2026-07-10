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
import { makeMount, GLOB_MAX_RESULTS } from '../src/mount.js';
import { buildMountFixture } from './_mount-fixture.js';

const globCasesUrl = new URL('./mount-glob-cases.json', import.meta.url);

const filePowers = makeFilePowers({ fs, path });

/**
 * The glob variant coverage matrix, shared verbatim with a future Rust/XS-side
 * runner. Each case pins the exact `glob(pattern)` result over the canonical
 * mount fixture; a discrepancy is either a Node regression or a cross-language
 * parity break.
 */
const { cases } = JSON.parse(fs.readFileSync(globCasesUrl, 'utf8'));

test('glob variant case table over the shared fixture (Rust/Node parity contract)', async t => {
  const { root, created } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const haveSymlink = created.has('escape');

  await null;
  let ran = 0;
  for (const testCase of cases) {
    if (testCase.requiresSymlink && !haveSymlink) {
      // The platform could not create the escaping symlink; its confinement
      // expectation is unobservable here.
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await E(mount).glob(testCase.pattern);
    t.deepEqual(
      [...result],
      testCase.expect,
      `${testCase.name} — glob(${JSON.stringify(testCase.pattern)})`,
    );
    ran += 1;
  }
  // Guard against a silently-empty table or a broken loop reporting green.
  t.true(ran >= 30, `expected the matrix to exercise many cases, ran ${ran}`);
});

test('glob rejects a pattern with no non-empty segments', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  await t.throwsAsync(() => E(mount).glob(''), {
    message: /at least one non-empty segment/,
  });
  await t.throwsAsync(() => E(mount).glob('/'), {
    message: /at least one non-empty segment/,
  });
  await t.throwsAsync(() => E(mount).glob('///'), {
    message: /at least one non-empty segment/,
  });
});

test('glob on a subView is scoped to the sub-root', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const sub = await E(mount).subView('src');
  // Results are relative to the sub-view's own root, and the sub-view sees
  // nothing above `src`.
  const result = await E(sub).glob('**');
  t.deepEqual(
    [...result],
    [
      'README.md',
      'index.js',
      'main.rs',
      'nested',
      'nested/deep.js',
      'nested/deeper',
      'nested/deeper/deepest.js',
      'util.js',
    ],
  );
  // A sub-view's glob is confined: a pattern reaching for a parent sibling
  // matches nothing (no `..` navigation, and denied roots are unreachable).
  t.deepEqual([...(await E(sub).glob('../README.md'))], []);
});

test('glob with an overridden empty deny set admits the credential names', async t => {
  const { root } = buildMountFixture(t);
  // An empty `deniedSegments` disables denial entirely, so the well-known
  // credential names become visible to glob. This proves the case-table's
  // empty results for `.ssh` / `.env` are load-bearing on the deny filter,
  // not on the names being absent from the fixture.
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers,
    deniedSegments: [],
  });
  t.deepEqual([...(await E(mount).glob('.ssh/*'))], ['.ssh/id_rsa']);
  t.deepEqual([...(await E(mount).glob('.env'))], ['.env']);
});

test('glob caps results at GLOB_MAX_RESULTS with deterministic truncation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-glob-wide-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  // A wide tree just over the cap. Zero-padded names so UTF-16 order is the
  // obvious numeric order and the truncation boundary is predictable.
  const total = GLOB_MAX_RESULTS + 5;
  await null;
  for (let i = 0; i < total; i += 1) {
    const name = `f${String(i).padStart(6, '0')}.txt`;
    fs.writeFileSync(path.join(root, name), '');
  }

  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const result = await E(mount).glob('*');
  t.is(result.length, GLOB_MAX_RESULTS, 'result is capped at the maximum');
  t.is(result[0], 'f000000.txt', 'the sorted-first entry survives');
  t.is(
    result[GLOB_MAX_RESULTS - 1],
    `f${String(GLOB_MAX_RESULTS - 1).padStart(6, '0')}.txt`,
    'truncation keeps the sorted-first GLOB_MAX_RESULTS entries',
  );
  // The entries past the cap are dropped, not surfaced.
  t.false(
    result.includes(`f${String(total - 1).padStart(6, '0')}.txt`),
    'entries beyond the cap are absent',
  );
});

test('glob matches an adversarial adjacent-star pattern in bounded time (no ReDoS)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-glob-redos-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  // A near-NAME_MAX entry whose long run of a single character maximizes
  // backtracking for a `literal*literal*…` pattern. The pattern is
  // caller-controlled, so this is reachable from a single `glob()` call.
  fs.writeFileSync(path.join(root, `${'a'.repeat(200)}X`), '');
  fs.writeFileSync(path.join(root, 'match-me'), '');

  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  // 40 literal `a` segments joined by `*` — the classic catastrophic-
  // backtracking shape. The former RegExp matcher blocked the (synchronous)
  // event loop for minutes on the adversarial entry above; the linear matcher
  // returns promptly. ava's per-test timeout is the backstop that reddens a
  // regression back to the RegExp.
  const pattern = Array.from({ length: 40 }, () => 'a').join('*');
  // The entry ends in `X`, so the trailing literal `a` cannot match: the point
  // is that the call returns at all rather than hanging.
  t.deepEqual([...(await E(mount).glob(pattern))], []);
  // The matcher is still correct for a pattern that does match.
  t.deepEqual([...(await E(mount).glob('m*e'))], ['match-me']);
});

test('glob(**) terminates on an in-confinement symlink cycle', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-glob-cycle-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'f.txt'), '');
  try {
    fs.symlinkSync('.', path.join(root, 'self')); // resolves to the root
    fs.symlinkSync('..', path.join(root, 'sub', 'up')); // resolves to an ancestor
  } catch {
    t.pass('platform cannot create symlinks; the cycle case is unobservable');
    return;
  }

  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  // Both symlinks resolve, via `realPath`, to a directory already on the
  // descent path, so `isConfinedPath`/`isDirectory` (which follow symlinks)
  // cannot exclude them. Without the ancestor-cycle guard the `**` walk
  // recurses `self/self/self/…` and `sub/up/sub/up/…` until PATH_MAX. The
  // guard records each cyclic symlink once as an entry and never re-enters it.
  const result = await E(mount).glob('**');
  t.deepEqual([...result], ['self', 'sub', 'sub/f.txt', 'sub/up']);
});
