// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import path from 'path';
import { E } from '@endo/eventual-send';

import { makeFilePowers } from '../src/manager-node-powers.js';
import { makeMount } from '../src/mount.js';
import { buildMountFixture } from './_mount-fixture.js';

const grepCasesUrl = new URL('./mount-grep-cases.json', import.meta.url);

const filePowers = makeFilePowers({ fs, path });

/**
 * `glorp(glob, grep)` is the fused equivalent of `grep(pattern, glob(g))`: it
 * enumerates the files matching the glob pattern and searches them for the grep
 * pattern in one call whose two required patterns a native filesystem can push
 * down and fuse. We pin that equivalence against the shared grep case table:
 * every case that carries an `options.glob` selector is exactly a `glorp(glob,
 * pattern)`, so glorp must reproduce grep's records over the canonical fixture.
 */
const { cases } = JSON.parse(fs.readFileSync(grepCasesUrl, 'utf8'));

test('glorp reproduces the grep case table as the fused glob→grep composition', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  await null;
  let ran = 0;
  // glorp requires both patterns, so only the glob-selecting cases map onto
  // it; a case without `options.glob` is a whole-tree grep, not a glorp.
  const glorpCases = cases.filter(
    testCase => (testCase.options ?? {}).glob !== undefined,
  );
  for (const testCase of glorpCases) {
    const options = testCase.options ?? {};
    const glorpOptions =
      options.maxResults === undefined
        ? {}
        : { maxResults: options.maxResults };
    // eslint-disable-next-line no-await-in-loop
    const result = await E(mount).glorp(
      options.glob,
      testCase.pattern,
      glorpOptions,
    );
    t.deepEqual(
      [...result],
      testCase.expect,
      `${testCase.name} — glorp(${JSON.stringify(options.glob)}, ${JSON.stringify(
        testCase.pattern,
      )})`,
    );
    ran += 1;
  }
  // Guard against a silently-empty table or a broken loop reporting green.
  t.true(ran >= 5, `expected several glob-selecting cases, ran ${ran}`);
});

test('glorp(g, p) equals grep(p, glob(g))', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const fused = await E(mount).glorp('src/**/*.js', 'export');
  const composed = await E(mount).grep('export', E(mount).glob('src/**/*.js'));
  t.deepEqual(
    [...fused],
    [...composed],
    'the fused call and the explicit composition return the same records',
  );
  t.deepEqual(
    [...fused],
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
});

test('glorp honors maxResults', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const capped = await E(mount).glorp('src/**/*.js', 'export', {
    maxResults: 2,
  });
  t.is([...capped].length, 2, 'the match record cap bounds the fused search');
});

test('glorp requires both patterns', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  // The interface guard makes both positionals required; a missing grep
  // pattern is rejected before the method runs.
  await t.throwsAsync(
    // Deliberately omitting the required grep pattern; the interface guard
    // rejects it at the exo boundary before the method body runs.
    // @ts-expect-error deliberate arity violation under test
    () => E(mount).glorp('src/**/*.js'),
    {
      message: /arg|argument|arity|glorp/i,
    },
    'a single-argument glorp is rejected by the interface guard',
  );
});

test('glorp rejects invalid maxResults', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  // NaN, Infinity, negatives, and fractions are hazards the interface guard
  // admits (M.number()) but the method body rejects.
  for (const bad of [NaN, Infinity, -1, 1.5]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => E(mount).glorp('src/**/*.js', 'export', { maxResults: bad }),
      { message: /maxResults/i },
      `maxResults ${String(bad)} is rejected`,
    );
  }
});

test('glorp clamps maxResults above the ceiling', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  // A finite safe integer above GREP_MAX_RESULTS clamps rather than throwing.
  const result = await E(mount).glorp('src/**/*.js', 'export', {
    maxResults: 1_000_000,
  });
  t.true([...result].length <= 4, 'clamped cap does not over-collect');
});

test('glorp dispatches to a native search.glorpFiles when present', async t => {
  const { root } = buildMountFixture(t);
  // A file powers object whose `search` carries a fused `glorpFiles` should be
  // used in preference to the JS composition; prove the seam is live by
  // recording the call and returning a sentinel batch.
  let called = false;
  const nativeSearch = harden({
    globPaths: () => {
      throw Error('globPaths should not be called when glorpFiles is present');
    },
    grepFiles: () => {
      throw Error('grepFiles should not be called when glorpFiles is present');
    },
    glorpFiles: async function* glorpFiles() {
      called = true;
      yield harden([
        { file: 'synthetic.js', line: 1, text: 'native fused match' },
      ]);
    },
  });
  const mount = makeMount({
    rootPath: root,
    readOnly: false,
    filePowers: { ...filePowers, search: nativeSearch },
  });
  const result = await E(mount).glorp('**/*.js', 'export');
  t.true(called, 'the native glorpFiles seam was consulted');
  t.deepEqual([...result], [
    { file: 'synthetic.js', line: 1, text: 'native fused match' },
  ]);
});
