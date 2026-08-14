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
