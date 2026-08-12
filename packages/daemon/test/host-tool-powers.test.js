// @ts-check

// `provideHostToolPowers` is the seam that lets `manager.js` and
// `host.js` carry no static import of `@endo/git` or
// `@endo/host-spawner`, which is what lets the daemon bundle for XS.
// No daemon test can reach its refusal branch, because every Node
// supervisor supplies all three tools, so the refusal diagnostic (the
// only diagnosis an XS-daemon user gets for a `git` or `shell`
// formula) is pinned here directly.

import '@endo/init/debug.js';

import test from 'ava';

import { provideHostToolPowers } from '../src/host-tool-powers.js';

const toolNames = ['gitClone', 'makeNativeGitBackend', 'makeHostSpawner'];

// The tools are typed from their real implementations, which take
// arguments this test never supplies: what is under test is whether a
// call is refused at all, before any argument is read.
/**
 * @param {Partial<import('../src/types.js').HostToolPowers>} [provided]
 * @returns {Record<string, (...args: unknown[]) => unknown>}
 */
const provideLoosely = provided =>
  /** @type {any} */ (provideHostToolPowers(provided));

test('every tool refuses when the supervisor supplied none', t => {
  for (const provided of [undefined, {}]) {
    const tools = provideLoosely(provided);
    for (const name of toolNames) {
      t.throws(() => tools[name](), {
        message: new RegExp(`no host tool powers.*"${name}"`),
      });
    }
  }
});

test('a supplied tool passes through untouched', t => {
  const gitClone = () => 'cloned';
  const tools = provideLoosely({ gitClone: /** @type {any} */ (gitClone) });
  t.is(tools.gitClone(), 'cloned');
  // The other two are still absent, so they still refuse: a partial
  // grant must not silently become a whole one.
  t.throws(() => tools.makeHostSpawner());
  t.throws(() => tools.makeNativeGitBackend());
});

test('the result is hardened, so a caller cannot swap a tool', t => {
  const tools = provideHostToolPowers({});
  t.true(Object.isFrozen(tools));
});
