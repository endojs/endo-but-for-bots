// @ts-check
/**
 * Unit tests for the Fae `glob` and `grep` tool makers (`makeGlobTool`,
 * `makeGrepTool`), the node-fs side of the tool-call-surface parity arc
 * (designs/fs-interface-reconciliation.md). The glob/grep dialects themselves
 * are exercised exhaustively in `@endo/platform`'s search tests; here we
 * verify the tool wiring: schema shape, delegation to the shared engine over
 * a real directory tree, the rendered text results, confinement, and the
 * glob/grep truncation caps.
 */

import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GLOB_MAX_RESULTS, GREP_MAX_RESULTS } from '@endo/platform/fs/search';

import { makeGlobTool, makeGrepTool } from '../src/tool-makers.js';

/**
 * Create a fresh temp dir populated from a { relativePath: contents } record,
 * returning its path.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, string>} files
 */
const makeFixture = (t, files) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-search-'));
  t.teardown(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf-8');
  }
  return cwd;
};

test('glob schema requires pattern and offers dirPath', t => {
  const tool = makeGlobTool('/tmp');
  const schema = tool.schema();
  t.is(schema.function.name, 'glob');
  const { properties, required } = schema.function.parameters;
  t.deepEqual(required, ['pattern']);
  t.truthy(properties.pattern);
  t.truthy(properties.dirPath);
  t.regex(tool.help(), /glob pattern/);
});

test('grep schema requires pattern and offers dirPath and glob', t => {
  const tool = makeGrepTool('/tmp');
  const schema = tool.schema();
  t.is(schema.function.name, 'grep');
  const { properties, required } = schema.function.parameters;
  t.deepEqual(required, ['pattern']);
  t.truthy(properties.pattern);
  t.truthy(properties.dirPath);
  t.truthy(properties.glob);
  t.regex(tool.help(), /regular expression/);
});

test('glob matches within one segment with * and across segments with **', async t => {
  const cwd = makeFixture(t, {
    'a.js': '',
    'b.txt': '',
    'src/c.js': '',
    'src/deep/d.js': '',
  });
  const tool = makeGlobTool(cwd);
  t.is(await tool.execute({ pattern: '*.js' }), 'a.js');
  t.is(
    await tool.execute({ pattern: '**/*.js' }),
    ['a.js', 'src/c.js', 'src/deep/d.js'].join('\n'),
  );
});

test('glob treats ? as a literal, per the engine dialect', async t => {
  const cwd = makeFixture(t, { 'ab.js': '', 'a?.js': '' });
  const tool = makeGlobTool(cwd);
  t.is(await tool.execute({ pattern: 'a?.js' }), 'a?.js');
});

test('glob searches under dirPath with results relative to it', async t => {
  const cwd = makeFixture(t, {
    'src/c.js': '',
    'src/deep/d.js': '',
    'a.js': '',
  });
  const tool = makeGlobTool(cwd);
  t.is(
    await tool.execute({ pattern: '**/*.js', dirPath: 'src' }),
    ['c.js', 'deep/d.js'].join('\n'),
  );
});

test('glob reports no matches without error', async t => {
  const cwd = makeFixture(t, { 'a.js': '' });
  const tool = makeGlobTool(cwd);
  t.is(await tool.execute({ pattern: '*.rs' }), 'No paths match *.rs');
});

test('glob rejects a dirPath escaping the working directory', async t => {
  const cwd = makeFixture(t, { 'a.js': '' });
  const tool = makeGlobTool(cwd);
  await t.throwsAsync(tool.execute({ pattern: '*', dirPath: '../..' }), {
    message: /Path traversal not allowed/,
  });
});

test('glob rejects a same-prefix sibling dirPath', async t => {
  const cwd = makeFixture(t, { 'a.js': '' });
  const sibling = `${cwd}-secret`;
  fs.mkdirSync(sibling);
  t.teardown(() => fs.rmSync(sibling, { recursive: true, force: true }));
  const tool = makeGlobTool(cwd);
  await t.throwsAsync(
    tool.execute({ pattern: '*', dirPath: path.relative(cwd, sibling) }),
    { message: /Path traversal not allowed/ },
  );
});

test('glob excludes symlinks resolving outside the working directory', async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-search-out-'));
  t.teardown(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.js'), '', 'utf-8');
  const cwd = makeFixture(t, { 'a.js': '' });
  fs.symlinkSync(outside, path.join(cwd, 'escape'));
  const tool = makeGlobTool(cwd);
  t.is(await tool.execute({ pattern: '**/*.js' }), 'a.js');
});

test('glob requires a non-empty pattern', async t => {
  const cwd = makeFixture(t, {});
  const tool = makeGlobTool(cwd);
  await t.throwsAsync(tool.execute({ pattern: '' }), {
    message: 'pattern is required',
  });
});

test('glob truncates beyond the cap and says so', async t => {
  const files = Object.fromEntries(
    Array.from({ length: GLOB_MAX_RESULTS + 1 }, (_, index) => [
      `${String(index).padStart(5, '0')}.js`,
      '',
    ]),
  );
  const cwd = makeFixture(t, files);
  const tool = makeGlobTool(cwd);
  const result = await tool.execute({ pattern: '*.js' });
  const rendered = result.split('\n');
  t.is(rendered.length, GLOB_MAX_RESULTS + 1);
  t.is(rendered[0], '00000.js');
  t.is(
    rendered[GLOB_MAX_RESULTS],
    `... (truncated at ${GLOB_MAX_RESULTS} results)`,
  );
});

test('grep renders file:line: text matches in path-then-line order', async t => {
  const cwd = makeFixture(t, {
    'a.txt': 'alpha\nbeta\nalpha again\n',
    'sub/b.txt': 'more alpha\n',
  });
  const tool = makeGrepTool(cwd);
  t.is(
    await tool.execute({ pattern: 'alpha' }),
    ['a.txt:1: alpha', 'a.txt:3: alpha again', 'sub/b.txt:1: more alpha'].join(
      '\n',
    ),
  );
});

test('grep evaluates the pattern as an ECMAScript regular expression', async t => {
  const cwd = makeFixture(t, {
    'a.js': 'const x = f(1);\nconst y = 2;\n',
  });
  const tool = makeGrepTool(cwd);
  t.is(
    await tool.execute({ pattern: String.raw`f\(\d\)` }),
    'a.js:1: const x = f(1);',
  );
});

test('grep restricts the file set with a glob pattern', async t => {
  const cwd = makeFixture(t, {
    'a.js': 'target\n',
    'b.txt': 'target\n',
    'src/c.js': 'target\n',
  });
  const tool = makeGrepTool(cwd);
  t.is(
    await tool.execute({ pattern: 'target', glob: '**/*.js' }),
    ['a.js:1: target', 'src/c.js:1: target'].join('\n'),
  );
});

test('grep searches under dirPath with results relative to it', async t => {
  const cwd = makeFixture(t, {
    'src/c.js': 'target\n',
    'a.js': 'target\n',
  });
  const tool = makeGrepTool(cwd);
  t.is(
    await tool.execute({ pattern: 'target', dirPath: 'src' }),
    'c.js:1: target',
  );
});

test('grep reports no matches without error', async t => {
  const cwd = makeFixture(t, { 'a.txt': 'alpha\n' });
  const tool = makeGrepTool(cwd);
  t.is(await tool.execute({ pattern: 'omega' }), 'No matches for omega');
});

test('grep requires a non-empty pattern', async t => {
  const cwd = makeFixture(t, {});
  const tool = makeGrepTool(cwd);
  await t.throwsAsync(tool.execute({ pattern: '' }), {
    message: 'pattern is required',
  });
});

test('grep truncates beyond the cap and says so', async t => {
  const lines = Array.from({ length: GREP_MAX_RESULTS + 1 }, () => 'hit');
  const cwd = makeFixture(t, { 'big.txt': `${lines.join('\n')}\n` });
  const tool = makeGrepTool(cwd);
  const result = await tool.execute({ pattern: 'hit' });
  const rendered = result.split('\n');
  t.is(rendered.length, GREP_MAX_RESULTS + 1);
  t.is(rendered[0], 'big.txt:1: hit');
  t.is(
    rendered[GREP_MAX_RESULTS],
    `... (truncated at ${GREP_MAX_RESULTS} matches)`,
  );
});

test('grep does not report an exactly-at-cap result as truncated', async t => {
  const lines = Array.from({ length: GREP_MAX_RESULTS }, () => 'hit');
  const cwd = makeFixture(t, { 'big.txt': `${lines.join('\n')}\n` });
  const tool = makeGrepTool(cwd);
  const result = await tool.execute({ pattern: 'hit' });
  const rendered = result.split('\n');
  t.is(rendered.length, GREP_MAX_RESULTS);
  t.false(result.includes('truncated'));
});
