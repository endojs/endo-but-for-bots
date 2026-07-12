// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import path from 'path';
import { E } from '@endo/eventual-send';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import { makeMount } from '../src/mount.js';
import { buildMountFixture } from './_mount-fixture.js';

const grepCasesUrl = new URL('./mount-grep-cases.json', import.meta.url);

const filePowers = makeFilePowers({ fs, path });

/**
 * glorp is the grep-over-glob convenience combinator: a promise-returning
 * method equivalent to `grep(grepPattern, await glob(globPattern), options)`.
 * It is purely additive on the decomposed glob/grep surfaces (#127 → grep C/C′,
 * glob B′); glob stays the independent path producer and grep the consumer, and
 * glorp is the thin wiring between them.
 *
 * The load-bearing property proved throughout this file is the *exact
 * equivalence* to the hand-written composition. Each test computes the manual
 * `grep(pattern, await glob(g))` and asserts glorp equals it, then additionally
 * pins the concrete records so a bug that broke glorp and grep identically is
 * still caught. Every test doubles as broken-wiring evidence (see the header of
 * each case for the specific mis-wiring it would fail on).
 */

const makeFixtureMount = t => {
  const { root } = buildMountFixture(t);
  return makeMount({ rootPath: root, readOnly: false, filePowers });
};

test('glorp equals grep over glob results across the grep case matrix', async t => {
  const mount = makeFixtureMount(t);
  const { cases } = JSON.parse(fs.readFileSync(grepCasesUrl, 'utf8'));
  // Every case in the shared matrix selects its files with `options.glob`;
  // that is exactly what glorp takes as its glob pattern.
  const globCases = cases.filter(
    testCase => (testCase.options ?? {}).glob !== undefined,
  );

  await null;
  let ran = 0;
  for (const testCase of globCases) {
    const options = testCase.options ?? {};
    const grepOptions =
      options.maxResults === undefined
        ? {}
        : { maxResults: options.maxResults };

    // The hand-written composition: grep the pattern over the paths glob
    // produced. This is the definition glorp must match exactly.
    // eslint-disable-next-line no-await-in-loop
    const paths = await E(mount).glob(options.glob);
    // eslint-disable-next-line no-await-in-loop
    const composed = await E(mount).grep(testCase.pattern, paths, grepOptions);

    // eslint-disable-next-line no-await-in-loop
    const glorped = await E(mount).glorp(
      options.glob,
      testCase.pattern,
      grepOptions,
    );

    const label = `${testCase.name} — glorp(${JSON.stringify(
      options.glob,
    )}, ${JSON.stringify(testCase.pattern)})`;
    // 1) glorp === the hand-written grep-over-glob composition.
    t.deepEqual([...glorped], [...composed], `${label}: equals composition`);
    // 2) glorp === the pinned expectation for this case (cross-language table).
    t.deepEqual([...glorped], testCase.expect, `${label}: pinned records`);
    ran += 1;
  }
  // Guard against a silently-empty table or a broken loop reporting green.
  t.true(ran >= 10, `expected the matrix to exercise many cases, ran ${ran}`);
});

test('glorp: matching set — greps only the globbed files', async t => {
  const mount = makeFixtureMount(t);
  // Broken-wiring evidence: if glorp swapped its arguments it would compute
  // grep("src/**/*.js", glob("export")); glob("export") matches no file, so the
  // result would be empty instead of these four records. If glorp ignored the
  // glob and grepped the whole tree, notes.txt has no "export" line, so this
  // exact set still pins the src-scoped answer.
  const result = await E(mount).glorp('src/**/*.js', 'export');
  t.deepEqual(
    [...result],
    [
      { file: 'src/index.js', line: 1, text: 'export const index = 1;' },
      { file: 'src/nested/deep.js', line: 1, text: 'export const deep = 3;' },
      {
        file: 'src/nested/deeper/deepest.js',
        line: 1,
        text: 'export const deepest = 4;',
      },
      { file: 'src/util.js', line: 1, text: 'export const util = 2;' },
    ],
  );
  // Same records as the hand-written composition.
  const composed = await E(mount).grep(
    'export',
    await E(mount).glob('src/**/*.js'),
  );
  t.deepEqual([...result], [...composed]);
});

test('glorp: glob scoping is load-bearing — the grep pattern matches only outside the glob set', async t => {
  const mount = makeFixtureMount(t);
  // "line" occurs in notes.txt but in no `src/**/*.js` file. A correct glorp
  // restricts grep to the globbed paths, so scoping to src js yields nothing —
  // whereas a glorp that grepped the whole tree (ignoring its glob) would echo
  // the notes.txt matches. This is the test that fails if glob is not actually
  // wired into grep's path set.
  const glorped = await E(mount).glorp('src/**/*.js', 'line');
  t.deepEqual([...glorped], [], 'no src js file contains "line"');

  // The composition it must equal.
  const composed = await E(mount).grep(
    'line',
    await E(mount).glob('src/**/*.js'),
  );
  t.deepEqual([...glorped], [...composed]);

  // And prove the pattern genuinely matches elsewhere in the tree — so the
  // empty result above is real glob-scoping, not a pattern that never matches.
  const wholeTree = await E(mount).grep('line');
  t.true(
    [...wholeTree].some(m => m.file === 'notes.txt'),
    'grep("line") over the whole tree does reach notes.txt',
  );
});

test('glorp: empty glob — no files matched yields no records', async t => {
  const mount = makeFixtureMount(t);
  // glob matches nothing, so grep runs over an empty path set → empty result,
  // and never throws. If glorp forgot to pass the (empty) glob output and fell
  // through to grep's whole-tree default, "export" would surface the src files.
  const glorped = await E(mount).glorp('no/such/**/*.zzz', 'export');
  t.deepEqual([...glorped], []);

  const emptyGlob = await E(mount).glob('no/such/**/*.zzz');
  t.deepEqual([...emptyGlob], [], 'the glob truly matches nothing');
  const composed = await E(mount).grep('export', emptyGlob);
  t.deepEqual([...glorped], [...composed]);
});

test('glorp: glob matches but the grep pattern does not', async t => {
  const mount = makeFixtureMount(t);
  // Files are selected, but the regex matches no line → empty, equal to the
  // hand-written composition.
  const glorped = await E(mount).glorp('src/**/*.js', 'NOTHING_MATCHES_XYZZY');
  t.deepEqual([...glorped], []);

  const composed = await E(mount).grep(
    'NOTHING_MATCHES_XYZZY',
    await E(mount).glob('src/**/*.js'),
  );
  t.deepEqual([...glorped], [...composed]);
});

test('glorp: options.maxResults is forwarded to the grep leg', async t => {
  const mount = makeFixtureMount(t);
  // The full match set is the four "export" lines; capping at 2 must drop to
  // two records, exactly as passing maxResults to grep would.
  const capped = await E(mount).glorp('src/**/*.js', 'export', {
    maxResults: 2,
  });
  t.is([...capped].length, 2, 'maxResults caps the record count');

  const composed = await E(mount).grep(
    'export',
    await E(mount).glob('src/**/*.js'),
    { maxResults: 2 },
  );
  t.deepEqual([...capped], [...composed]);
});

test('glorp on a subView is scoped to the sub-root', async t => {
  const mount = makeFixtureMount(t);
  // A subView narrows the confinement root; glorp composes the subView's own
  // glob and grep faces, so its results are relative to and confined by the
  // sub-root — the same property glob and grep have individually.
  const nested = await E(mount).subView(['src', 'nested']);
  const glorped = await E(nested).glorp('**/*.js', 'const');
  const composed = await E(nested).grep(
    'const',
    await E(nested).glob('**/*.js'),
  );
  t.deepEqual([...glorped], [...composed]);
  t.true([...glorped].length > 0, 'the sub-root has matching files');
  // Every path is sub-root-relative (no `src/nested/` prefix leaking through).
  t.true(
    [...glorped].every(m => !m.file.startsWith('src/')),
    'results are relative to the sub-root',
  );
});
