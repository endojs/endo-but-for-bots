// @ts-check
/**
 * The `readText`, `writeText`, and `editText` tools must be able to target a
 * daemon `EndoDirectory`, whose file methods refuse a bare-string name through
 * `namePathFrom`. The stub below applies that same validator, so a `fileName`
 * that the tool schema forced into a string would fail here as it does
 * against a real directory.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { namePathFrom } from '@endo/daemon/pet-name.js';
import { makeExecuteTool } from '../tool-dispatch.js';

const makeDirectoryStub = () => {
  /** @type {Map<string, string>} */
  const store = new Map();
  const directory = {
    /** @param {unknown} petNamePath */
    readText(petNamePath) {
      const key = namePathFrom(petNamePath).join('/');
      if (!store.has(key)) {
        return Promise.reject(new Error(`No such file: ${key}`));
      }
      return Promise.resolve(store.get(key));
    },
    /**
     * @param {unknown} petNamePath
     * @param {string} content
     */
    writeText(petNamePath, content) {
      store.set(namePathFrom(petNamePath).join('/'), content);
      return Promise.resolve(undefined);
    },
  };
  const powers = {
    lookup(_petNamePath) {
      return Promise.resolve(directory);
    },
  };
  const executeTool = makeExecuteTool(powers);
  /**
   * @param {string} name
   * @param {any} args
   * @returns {Promise<any>}
   */
  const run = (name, args) => executeTool(name, args);
  return { run, store };
};

test('writeText and readText reach a daemon directory with a path fileName', async t => {
  const { run, store } = makeDirectoryStub();
  await run('writeText', {
    petNamePath: ['notes'],
    fileName: ['a.txt'],
    content: 'x',
  });
  t.is(store.get('a.txt'), 'x');
  t.is(
    await run('readText', { petNamePath: ['notes'], fileName: ['a.txt'] }),
    'x',
  );
});

test('editText reaches a daemon directory with a path fileName', async t => {
  const { run, store } = makeDirectoryStub();
  store.set('a.txt', 'hello world\n');
  const result = await run('editText', {
    petNamePath: ['notes'],
    fileName: ['a.txt'],
    edits: [{ oldText: 'world', newText: 'there' }],
  });
  t.is(result.applied, 1);
  t.true(result.diff.includes('a.txt'));
  t.is(store.get('a.txt'), 'hello there\n');
});

test('a string fileName against a daemon directory carries the retry hint', async t => {
  const { run } = makeDirectoryStub();
  await t.throwsAsync(
    run('readText', { petNamePath: ['notes'], fileName: 'a.txt' }),
    { message: /try again with an array of path components/ },
  );
});
