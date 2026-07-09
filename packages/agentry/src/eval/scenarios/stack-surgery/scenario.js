// @ts-check
/// <reference types="ses"/>

/** @import { GitScenario } from '../../types.js' */

import { assertStackSurgeryOutcome } from './outcome.js';

/**
 * @typedef {object} ExpectedStackSurgeryFile
 * @property {string} path
 * @property {string} content
 */

/**
 * @typedef {object} StackSurgeryTarget
 * @property {ExpectedStackSurgeryFile[]} files
 * @property {string[]} summaries Oldest-to-newest summaries expected on top of
 *   `main`.
 */

export const EXPECTED_STACK_SURGERY_FILES = harden([
  {
    path: 'alpha/index.js',
    content: `export const alphaName = 'alpha-stack';\nexport const alphaMode = 'surgical';\n`,
  },
  {
    path: 'beta/index.js',
    content: `export const betaName = 'beta-stack';\nexport const betaMode = 'isolated';\n`,
  },
  {
    path: 'beta/stack.test.js',
    content: `import { betaMode } from './index.js';\n\nexport const betaStackCovered = betaMode === 'isolated';\n`,
  },
  {
    path: 'gamma/tooling.js',
    content: `export const gammaTooling = () => 'ready';\n`,
  },
  {
    path: 'docs/stack.md',
    content: `# Stack Surgery\n\nGamma tooling is replayed before this docs note.\n`,
  },
]);

export const EXPECTED_STACK_SURGERY_SUMMARIES = harden([
  'feat(alpha): update stack surgery support',
  'feat(beta): update stack surgery support',
  'feat(gamma): add tooling helper',
  'docs: note stack surgery workflow',
  'test(beta): cover stack surgery',
]);

const DEFAULT_EXPECTED = harden({
  files: EXPECTED_STACK_SURGERY_FILES,
  summaries: EXPECTED_STACK_SURGERY_SUMMARIES,
});

/**
 * The stack-surgery git code-mode scenario. The fixture starts on
 * `topic/stack-surgery`, where the agent must split a mixed alpha/beta commit,
 * autosquash fixups, replay side branches in the requested order, and reword a
 * vague beta-test commit.
 *
 * @param {object} [options]
 * @param {StackSurgeryTarget} [options.expected]
 * @returns {GitScenario<StackSurgeryTarget>}
 */
export const makeStackSurgeryScenario = ({
  expected = DEFAULT_EXPECTED,
} = {}) =>
  harden({
    name: 'stack-surgery',
    expected,
    prompt: `Rework the current topic/stack-surgery branch into a clean stack on main.

Create separate conventional commits for the alpha and beta package changes, autosquashing their fixup commits so no fixup! commits remain.
Replay side/gamma-tooling and then side/docs-note in that order without requiring their original commit ids.
Reword the vague beta test commit to exactly: test(beta): cover stack surgery.
When finished, leave the worktree and index clean, with these files at their target contents:
${expected.files
  .map(entry => `- ${entry.path}:\n${entry.content}`)
  .join('\n')}`,
    assertOutcome: ({ git, readText }) =>
      assertStackSurgeryOutcome({ git, readText, expected }),
  });
harden(makeStackSurgeryScenario);
