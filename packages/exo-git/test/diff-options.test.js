// @ts-check
/// <reference types="ses"/>

/**
 * Coverage for the option translation `Git.diff` and `Git.diffText` share:
 * both forward the same backend options, collapsing `GitRef` revisions to
 * their names and copying explicit `paths`.
 *
 * @import { GitBackend } from '../src/git.js'
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import { makeGit, makeNotYetImplementedBackend } from '../src/index.js';

const makeDiffHarness = () => {
  /** @type {unknown[]} */
  const calls = [];
  /** @type {GitBackend} */
  const backend = harden({
    ...makeNotYetImplementedBackend(),
    diff: async options => {
      calls.push(harden(['diff', options]));
      return harden({ files: harden([]) });
    },
    diffText: async options => {
      calls.push(harden(['diffText', options]));
      return '';
    },
  });
  const mount = makeExo('FakeGitDiffOptionsMount', undefined, {});
  const git = makeGit(
    /** @type {Parameters<typeof makeGit>[0]} */ (
      /** @type {unknown} */ ({ mount, backend, lineageOf: () => undefined })
    ),
  );
  return { git, calls };
};

test('diff and diffText forward the same resolved options', async t => {
  const { git, calls } = makeDiffHarness();
  const options = harden({
    cached: true,
    base: harden({ kind: /** @type {const} */ ('branch'), name: 'main' }),
    head: 'topic',
    paths: harden(['a.txt']),
  });
  const structured = await E(git).diff(options);
  const text = await E(git).diffText(options);
  t.deepEqual(structured, { files: [] });
  t.is(text, '');
  const resolved = {
    cached: true,
    base: 'main',
    head: 'topic',
    paths: ['a.txt'],
  };
  t.deepEqual(calls, [
    ['diff', resolved],
    ['diffText', resolved],
  ]);
});

test('diff with no options forwards an empty option record', async t => {
  const { git, calls } = makeDiffHarness();
  await E(git).diff();
  await E(git).diffText({ paths: harden([]) });
  t.deepEqual(calls, [
    ['diff', {}],
    ['diffText', {}],
  ]);
});
