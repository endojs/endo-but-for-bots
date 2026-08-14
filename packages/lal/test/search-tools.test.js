// @ts-check
/**
 * Lal glob/grep dispatch over the daemon-local EndoMount search surface.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { makeExecuteTool } from '../tool-dispatch.js';

const makeStub = () => {
  const calls = [];
  const capability = {
    glob(pattern) {
      calls.push(['glob', pattern]);
      return Promise.resolve(['src/a.js', 'src/b.js']);
    },
    grep(pattern, paths, options) {
      calls.push(['grep', pattern, paths, options]);
      return Promise.resolve([
        { file: 'src/a.js', line: 2, text: 'const TODO = true;' },
      ]);
    },
    glorp(globPattern, grepPattern, options) {
      calls.push(['glorp', globPattern, grepPattern, options]);
      return Promise.resolve([
        { file: 'src/a.js', line: 2, text: 'const TODO = true;' },
      ]);
    },
  };
  const powers = {
    lookup(petNameOrPath) {
      calls.push(['lookup', petNameOrPath]);
      return Promise.resolve(capability);
    },
  };
  const executeTool = makeExecuteTool(powers);
  /**
   * @param {string} name
   * @param {any} args
   * @returns {Promise<any>}
   */
  const run = (name, args) => executeTool(name, args);
  return { calls, run };
};

test('glob delegates to the named capability', async t => {
  const { calls, run } = makeStub();
  const result = await run('glob', {
    petNameOrPath: 'workspace',
    pattern: 'src/**/*.js',
  });
  t.deepEqual(result, ['src/a.js', 'src/b.js']);
  t.deepEqual(calls, [
    ['lookup', 'workspace'],
    ['glob', 'src/**/*.js'],
  ]);
});

test('grep searches all files when no glob is supplied', async t => {
  const { calls, run } = makeStub();
  const result = await run('grep', {
    petNameOrPath: ['spaces', 'workspace'],
    pattern: 'TODO',
  });
  t.deepEqual(result, [
    { file: 'src/a.js', line: 2, text: 'const TODO = true;' },
  ]);
  t.deepEqual(calls, [
    ['lookup', ['spaces', 'workspace']],
    ['grep', 'TODO', undefined, undefined],
  ]);
});

test('grep with a glob uses the fused glorp surface', async t => {
  const { calls, run } = makeStub();
  await run('grep', {
    petNameOrPath: 'workspace',
    pattern: 'TODO',
    glob: 'src/**/*.js',
  });
  t.deepEqual(calls, [
    ['lookup', 'workspace'],
    ['glorp', 'src/**/*.js', 'TODO', undefined],
  ]);
});

test('grep forwards maxResults', async t => {
  const { calls, run } = makeStub();
  await run('grep', {
    petNameOrPath: 'workspace',
    pattern: 'TODO',
    maxResults: 7,
  });
  t.deepEqual(calls, [
    ['lookup', 'workspace'],
    ['grep', 'TODO', undefined, { maxResults: 7 }],
  ]);
});

test('grep with a glob forwards maxResults to the fused glorp surface', async t => {
  const { calls, run } = makeStub();
  await run('grep', {
    petNameOrPath: 'workspace',
    pattern: 'TODO',
    glob: 'src/**/*.js',
    maxResults: 7,
  });
  t.deepEqual(calls, [
    ['lookup', 'workspace'],
    ['glorp', 'src/**/*.js', 'TODO', { maxResults: 7 }],
  ]);
});

test('grep validates optional argument shapes before dispatch', async t => {
  const { calls, run } = makeStub();
  await t.throwsAsync(
    () =>
      run('grep', {
        petNameOrPath: 'workspace',
        pattern: 'TODO',
        maxResults: 'many',
      }),
    { message: /grep args/ },
  );
  t.deepEqual(calls, []);
});

test('grep rejects out-of-range maxResults before dispatch', async t => {
  await null;
  // `NaN`/`Infinity`/negative/zero counts would defeat or degenerate the
  // daemon's result cap (`NaN` and `0` both collapse `slice(0, maxResults)` to
  // `slice(0, 0)`, silently truncating to empty), so they must be rejected at
  // the tool boundary rather than forwarded to the capability.
  //
  // The non-finite values are fed as their SmallCaps encodings (`'#NaN'`,
  // `'#Infinity'`, `'#-Infinity'`) — which is how they actually arrive over the
  // wire — because a JS `NaN`/`Infinity` JSON-stringifies to `null` inside
  // `decodeToolArgs` before the range matcher ever sees it, so a plain-number
  // case would prove nothing about the guard (`null` is rejected by a bare
  // `M.number()` too). `-1` and `0` survive as plain numbers.
  for (const maxResults of ['#NaN', '#Infinity', '#-Infinity', -1, 0]) {
    const { calls, run } = makeStub();
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        run('grep', {
          petNameOrPath: 'workspace',
          pattern: 'TODO',
          maxResults,
        }),
      { message: /grep args/ },
      `maxResults ${maxResults} should be rejected`,
    );
    t.deepEqual(calls, []);
  }
});
