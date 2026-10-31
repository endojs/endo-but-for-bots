// @ts-check

/**
 * The local Git capability is described in four places that are maintained
 * separately: the runtime facet guards and method lists in
 * `@endo/exo-git/src/interfaces.js` (which `makeGitKit`'s exo facets are
 * checked against in exo-git's `kit-conformance.test.js`), the posture types
 * in `packages/exo-git/src/types.ts` (which `makeGit`'s overloads return, as
 * pinned in exo-git's `types.test-d.ts`), and the generated code-mode
 * declarations in `generated/code-mode-globals/git-declarations.js`. This
 * test pins each posture's method set across all of them, so a verb added
 * to, removed from, or moved between facets in any one place fails here
 * until every other place agrees.
 */

import test from '@endo/ses-ava/prepare-endo.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getInterfaceGuardPayload } from '@endo/patterns';
import {
  GitInterface,
  GitReaderInterface,
  GitRewriterInterface,
  GitWriterInterface,
} from '@endo/exo-git';
import {
  GIT_READER_METHODS,
  GIT_REWRITER_METHODS,
  GIT_REWRITER_ONLY_METHODS,
  GIT_WRITER_METHODS,
} from '@endo/exo-git/src/interfaces.js';

import { gitDeclarations } from '../generated/code-mode-globals/git-declarations.js';
import { extractTsFileTextIR } from '../scripts/code-mode-type-extract.js';
import { listDeclaredTypeMembers } from './_util/declaration-inspect.js';

/** @import { InterfaceGuard } from '@endo/patterns' */

const gitTypesFileName = fileURLToPath(
  new URL('../../exo-git/src/types.ts', import.meta.url),
);
const gitTypesText = readFileSync(gitTypesFileName, 'utf8');

/**
 * @param {readonly string[]} names
 * @returns {string[]}
 */
const sorted = names => [...names].sort();

/**
 * @param {unknown} guard
 * @returns {string[]}
 */
const guardMethodNames = guard =>
  sorted(
    Object.keys(
      getInterfaceGuardPayload(/** @type {InterfaceGuard} */ (guard))
        .methodGuards,
    ),
  );

/**
 * Every member of a posture type in `types.ts`, including members it reaches
 * through intersection with a weaker posture.
 *
 * @param {string} rootType
 * @returns {string[]}
 */
const postureTypeMembers = rootType =>
  sorted(
    extractTsFileTextIR({
      fileName: gitTypesFileName,
      text: gitTypesText,
      rootType,
    }).members.map(member => member.name),
  );

/**
 * The members of a checked-in generated declaration, read from the artifact
 * text an agent is actually shown.
 *
 * @param {'git' | 'gitHistory' | 'gitReadOnly'} name
 * @returns {string[]}
 */
const generatedMembers = name => {
  const { aux, body } = gitDeclarations[name];
  return sorted(
    listDeclaredTypeMembers(
      `${aux}\ntype GeneratedRoot = ${body};`,
      'GeneratedRoot',
    ),
  );
};

const POSTURES = harden([
  {
    facet: 'reader',
    methods: GIT_READER_METHODS,
    guard: GitReaderInterface,
    type: 'ReadOnlyEndoGit',
  },
  {
    facet: 'writer',
    methods: GIT_WRITER_METHODS,
    guard: GitWriterInterface,
    type: 'ReadWriteEndoGit',
  },
  {
    facet: 'rewriter',
    methods: GIT_REWRITER_METHODS,
    guard: GitRewriterInterface,
    type: 'HistoryRewriteEndoGit',
  },
]);

test('each facet guard advertises exactly its method list', t => {
  for (const { facet, methods, guard } of POSTURES) {
    t.deepEqual(guardMethodNames(guard), sorted(methods), facet);
  }
});

test('the GitInterface compatibility guard is the rewriter facet', t => {
  t.deepEqual(guardMethodNames(GitInterface), sorted(GIT_REWRITER_METHODS));
});

test('each types.ts posture type declares exactly its facet methods', t => {
  for (const { facet, methods, type } of POSTURES) {
    t.deepEqual(postureTypeMembers(type), sorted(methods), `${facet}: ${type}`);
  }
});

test('the read-only code-mode declaration is the reader facet', t => {
  t.deepEqual(generatedMembers('gitReadOnly'), sorted(GIT_READER_METHODS));
});

test('the read/write code-mode declaration is the writer facet', t => {
  t.deepEqual(generatedMembers('git'), sorted(GIT_WRITER_METHODS));
});

// `gitHistory` is a supplement rendered beside `git`, not a whole facet: it
// carries the rewriter-only verbs plus the unattenuated `commit` (whose
// `amend` option `git` drops).
test('the history code-mode declaration adds exactly the rewriter verbs', t => {
  t.deepEqual(
    generatedMembers('gitHistory'),
    sorted([...GIT_REWRITER_ONLY_METHODS, 'commit']),
  );
  t.deepEqual(
    sorted([
      ...new Set([
        ...generatedMembers('git'),
        ...generatedMembers('gitHistory'),
      ]),
    ]),
    sorted(GIT_REWRITER_METHODS),
  );
});
