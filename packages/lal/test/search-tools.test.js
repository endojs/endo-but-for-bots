// @ts-check
/**
 * Lal glob/grep dispatch over the daemon-local EndoMount search surface.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { makeExecuteTool } from '../tool-dispatch.js';

const makeStub = () => {
  const calls = [];
  const capability = {
    glob(pattern, options) {
      // Record the options record only when one was actually passed, so a
      // dispatch that forwards `(pattern)` stays distinguishable from one that
      // forwards `(pattern, undefined)` — the difference a capability
      // predating the parameter would notice.
      calls.push(
        options === undefined ? ['glob', pattern] : ['glob', pattern, options],
      );
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

test('glob passes special-character patterns through verbatim', async t => {
  await null;
  // These patterns begin with SmallCaps special-prefix characters (`*`, `(`,
  // `#`, `-`), which the arg decoder would otherwise throw on or silently
  // coerce. They are the modal inputs for these tools (`**/*.js`, an alternation
  // group), so they must reach the capability byte-for-byte.
  for (const pattern of ['*.js', '**/*.js', '(foo|bar)', '#define', '-x']) {
    const { calls, run } = makeStub();
    // eslint-disable-next-line no-await-in-loop
    const result = await run('glob', {
      petNameOrPath: 'workspace',
      pattern,
    });
    t.deepEqual(result, ['src/a.js', 'src/b.js']);
    t.deepEqual(
      calls,
      [
        ['lookup', 'workspace'],
        ['glob', pattern],
      ],
      `glob(${pattern}) should reach the capability verbatim`,
    );
  }
});

test('grep passes a special-character regexp and glob filter through verbatim', async t => {
  const { calls, run } = makeStub();
  await run('grep', {
    petNameOrPath: 'workspace',
    pattern: '(foo|bar)',
    glob: '*.js',
  });
  t.deepEqual(calls, [
    ['lookup', 'workspace'],
    ['glorp', '*.js', '(foo|bar)', undefined],
  ]);
});

// `followSymlinks` is the `rg -L` escape hatch. It exists in the platform
// engine and the daemon mount face; these pin that the tool boundary forwards
// it rather than swallowing it, which is the failure the option is easiest to
// ship with — everything still passes, the sweep just never widens.
test('glob forwards followSymlinks as an options record', async t => {
  const { calls, run } = makeStub();
  await run('glob', {
    petNameOrPath: 'workspace',
    pattern: 'src/**/*.js',
    followSymlinks: true,
  });
  t.deepEqual(calls, [
    ['lookup', 'workspace'],
    ['glob', 'src/**/*.js', { followSymlinks: true }],
  ]);
});

test('glob omits the options record when followSymlinks is absent', async t => {
  const { calls, run } = makeStub();
  await run('glob', { petNameOrPath: 'workspace', pattern: 'src/**' });
  // One argument, not `(pattern, {})`: a capability predating the parameter
  // must still answer a plain glob.
  t.deepEqual(calls[1], ['glob', 'src/**']);
});

test('grep forwards followSymlinks to the whole-tree walk', async t => {
  const { calls, run } = makeStub();
  await run('grep', {
    petNameOrPath: 'workspace',
    pattern: 'TODO',
    followSymlinks: true,
  });
  t.deepEqual(calls, [
    ['lookup', 'workspace'],
    ['grep', 'TODO', undefined, { followSymlinks: true }],
  ]);
});

test('grep with a glob forwards followSymlinks to the fused glorp surface', async t => {
  const { calls, run } = makeStub();
  await run('grep', {
    petNameOrPath: 'workspace',
    pattern: 'TODO',
    glob: 'src/**/*.js',
    maxResults: 5,
    followSymlinks: true,
  });
  t.deepEqual(calls, [
    ['lookup', 'workspace'],
    ['glorp', 'src/**/*.js', 'TODO', { maxResults: 5, followSymlinks: true }],
  ]);
});

test('a non-boolean followSymlinks is rejected before dispatch', async t => {
  const { calls, run } = makeStub();
  await t.throwsAsync(
    () =>
      run('glob', {
        petNameOrPath: 'workspace',
        pattern: 'src/**',
        followSymlinks: 'yes',
      }),
    { message: /glob args/ },
  );
  t.deepEqual(calls, []);
});
