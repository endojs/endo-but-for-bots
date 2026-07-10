// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { Ajv } from 'ajv';
import { Far } from '@endo/pass-style';
import { E } from '@endo/eventual-send';

import {
  makeMountGlobTool,
  makeMountGrepTool,
  makeMountSearchTools,
} from '../src/mount-search.js';

const ajv = new Ajv({ strict: false });

/**
 * A fake `EndoMount` search slice: `glob` returns a fixed sorted path list;
 * `grep` resolves its `paths` argument (which may be a promise, mirroring the
 * exo's `M.await` guard) and returns one record per matching path. Records the
 * arguments it was called with so the composition and cap are observable.
 *
 * @param {object} config
 * @param {string[]} config.globResult
 * @param {Array<{ file: string, line: number, text: string }>} config.grepResult
 */
const makeFakeMount = ({ globResult, grepResult }) => {
  const calls = { glob: [], grep: [] };
  const mount = Far('FakeMount', {
    glob: async pattern => {
      calls.glob.push(pattern);
      return harden([...globResult]);
    },
    grep: async (pattern, paths, options) => {
      // Mirror the real mount: the exo awaits a promise `paths` argument.
      const resolvedPaths = paths === undefined ? undefined : await paths;
      calls.grep.push({ pattern, paths: resolvedPaths, options });
      const maxResults = options?.maxResults;
      const capped =
        maxResults === undefined ? grepResult : grepResult.slice(0, maxResults);
      return harden(capped.map(r => ({ ...r })));
    },
  });
  return { mount, calls };
};

test('mountGlob advertises a valid JSON Schema and returns paths with a truncated flag', async t => {
  const { mount } = makeFakeMount({
    globResult: ['a.js', 'b.js', 'c.js'],
    grepResult: [],
  });
  const tool = makeMountGlobTool(mount);
  t.is(tool.name, 'mountGlob');
  t.true(ajv.validateSchema(tool.parameters));
  t.is(tool.parameters, tool.inputSchema);

  const result = await tool.invoke(harden({ pattern: '**/*.js' }));
  t.deepEqual(result, { paths: ['a.js', 'b.js', 'c.js'], truncated: false });
});

test('mountGlob caps at maxResults and reports truncation', async t => {
  const { mount } = makeFakeMount({
    globResult: ['a', 'b', 'c', 'd'],
    grepResult: [],
  });
  const tool = makeMountGlobTool(mount);
  const result = await tool.invoke(harden({ pattern: '*', maxResults: 2 }));
  t.deepEqual(result, { paths: ['a', 'b'], truncated: true });
});

test('mountGlob rejects an unknown argument key and an empty pattern', async t => {
  const { mount } = makeFakeMount({ globResult: [], grepResult: [] });
  const tool = makeMountGlobTool(mount);
  await t.throwsAsync(() => tool.invoke(harden({ pattern: 'x', bogus: 1 })), {
    message: /unexpected mountGlob argument key/,
  });
  await t.throwsAsync(() => tool.invoke(harden({ pattern: '' })), {
    message: /non-empty string pattern/,
  });
});

test('mountGrep composes glob into grep at the tool layer, filesGlob defaulting to every file', async t => {
  const { mount, calls } = makeFakeMount({
    globResult: ['src/a.js', 'src/b.js'],
    grepResult: [
      { file: 'src/a.js', line: 1, text: 'export const a = 1;' },
      { file: 'src/b.js', line: 2, text: 'export const b = 2;' },
    ],
  });
  const tool = makeMountGrepTool(mount);
  t.true(ajv.validateSchema(tool.parameters));

  const result = await tool.invoke(harden({ pattern: 'export' }));
  t.deepEqual(result, {
    matches: [
      { file: 'src/a.js', line: 1, text: 'export const a = 1;' },
      { file: 'src/b.js', line: 2, text: 'export const b = 2;' },
    ],
    truncated: false,
  });
  // The tool globbed the default '**/*' and fed the resolved paths into grep.
  t.deepEqual(calls.glob, ['**/*']);
  t.is(calls.grep.length, 1);
  t.deepEqual(calls.grep[0].paths, ['src/a.js', 'src/b.js']);
});

test('mountGrep honors filesGlob and reports truncation when more matches exist', async t => {
  const { mount, calls } = makeFakeMount({
    globResult: ['x.txt'],
    grepResult: [
      { file: 'x.txt', line: 1, text: 'one' },
      { file: 'x.txt', line: 2, text: 'two' },
      { file: 'x.txt', line: 3, text: 'three' },
    ],
  });
  const tool = makeMountGrepTool(mount);
  const result = await tool.invoke(
    harden({ pattern: '.', filesGlob: '*.txt', maxResults: 2 }),
  );
  t.deepEqual(calls.glob, ['*.txt']);
  t.is(result.truncated, true);
  t.is(result.matches.length, 2);
});

test('mountGrep rejects a non-string filesGlob and an unknown key', async t => {
  const { mount } = makeFakeMount({ globResult: [], grepResult: [] });
  const tool = makeMountGrepTool(mount);
  await t.throwsAsync(
    () => tool.invoke(harden({ pattern: 'x', filesGlob: 3 })),
    { message: /filesGlob must be a string/ },
  );
  await t.throwsAsync(() => tool.invoke(harden({ pattern: 'x', nope: 1 })), {
    message: /unexpected mountGrep argument key/,
  });
});

test('makeMountSearchTools returns both read-scoped tools', async t => {
  const { mount } = makeFakeMount({ globResult: [], grepResult: [] });
  const tools = makeMountSearchTools(mount);
  t.deepEqual(
    tools.map(tool => tool.name),
    ['mountGlob', 'mountGrep'],
  );
});

test('the search tools use only the mount capability they are handed (no ambient authority)', async t => {
  // A capability that throws on any unexpected method proves the tools call
  // only glob/grep.
  const mount = Far('StrictMount', {
    glob: async () => harden(['only.js']),
    grep: async (_pattern, paths) => {
      const resolved = paths === undefined ? undefined : await paths;
      t.deepEqual(resolved, ['only.js']);
      return harden([{ file: 'only.js', line: 1, text: 'hit' }]);
    },
  });
  const grepTool = makeMountGrepTool(mount);
  const result = await grepTool.invoke(harden({ pattern: 'hit' }));
  t.deepEqual(result.matches, [{ file: 'only.js', line: 1, text: 'hit' }]);
  await E(mount).glob('noop'); // touch E to keep the import meaningful
});
