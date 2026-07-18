// @ts-check

// Tests for the stack-surgery eval: scorer-level assertions over hand-built
// final states, plus the scripted faux-model pass-path that drives the real
// code-mode git-loop agent through the history-editing verbs the scenario is
// the acceptance contract for (cherryPick, reword, rebase autosquash) and
// scores the run by outcome assertion.

import test from '@endo/ses-ava/prepare-endo.js';
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/compat';

import {
  assertStackSurgeryOutcome,
  makeStackSurgeryScenario,
} from '../../src/eval/scenarios/stack-surgery/index.js';
import { runGitScenario } from '../../src/eval/index.js';
import { stackSurgerySource } from '../../src/eval/scenarios/stack-surgery/reference.js';
import { readText } from '../_eval-fixture.js';
import {
  EXPECTED_STACK_SURGERY_FILES,
  EXPECTED_STACK_SURGERY_SUMMARIES,
  provisionStackSurgeryRepo,
  writeRepoFile,
} from './_stack-surgery-repo.js';

/** @import { Model } from '@earendil-works/pi-ai' */

/**
 * @param {import('ava').ExecutionContext} t
 * @param {import('@earendil-works/pi-ai').AssistantMessage[]} responses
 * @returns {Model<string>}
 */
const fauxModel = (t, responses) => {
  const registration = registerFauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-model' }],
  });
  registration.setResponses(responses);
  t.teardown(() => registration.unregister());
  return registration.getModel();
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {string} source
 * @returns {Model<string>}
 */
const evaluateOnceModel = (t, source) =>
  fauxModel(t, [
    fauxAssistantMessage(fauxToolCall('evaluate', { source }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done'),
  ]);

/**
 * @param {Awaited<ReturnType<typeof provisionStackSurgeryRepo>>} repo
 * @param {object} [options]
 * @param {string[]} [options.summaries]
 * @param {Set<string>} [options.omitFiles]
 * @param {boolean} [options.reset]
 * @returns {Promise<void>}
 */
const writeFinalStack = async (
  repo,
  {
    summaries = EXPECTED_STACK_SURGERY_SUMMARIES,
    omitFiles = new Set(),
    reset = true,
  } = {},
) => {
  const byPath = new Map(
    EXPECTED_STACK_SURGERY_FILES.map(entry => [entry.path, entry.content]),
  );
  /** @param {string} filePath */
  const contentFor = filePath => {
    const content = byPath.get(filePath);
    if (content === undefined) {
      throw new Error(`missing expected fixture content for ${filePath}`);
    }
    return content;
  };
  if (reset) {
    await repo.run(['reset', '--hard', 'main']);
  }

  if (summaries.includes('feat(alpha): update stack surgery support')) {
    await writeRepoFile(
      repo.repoRoot,
      'alpha/index.js',
      contentFor('alpha/index.js'),
    );
    await repo.run(['add', 'alpha/index.js']);
    await repo.run([
      'commit',
      '-q',
      '-m',
      'feat(alpha): update stack surgery support',
    ]);
  }

  if (summaries.includes('feat(beta): update stack surgery support')) {
    await writeRepoFile(
      repo.repoRoot,
      'beta/index.js',
      contentFor('beta/index.js'),
    );
    await repo.run(['add', 'beta/index.js']);
    await repo.run([
      'commit',
      '-q',
      '-m',
      'feat(beta): update stack surgery support',
    ]);
  }

  if (
    summaries.includes('feat(gamma): add tooling helper') &&
    !omitFiles.has('gamma/tooling.js')
  ) {
    await writeRepoFile(
      repo.repoRoot,
      'gamma/tooling.js',
      contentFor('gamma/tooling.js'),
    );
    await repo.run(['add', 'gamma/tooling.js']);
    await repo.run(['commit', '-q', '-m', 'feat(gamma): add tooling helper']);
  }

  if (
    summaries.includes('docs: note stack surgery workflow') &&
    !omitFiles.has('docs/stack.md')
  ) {
    await writeRepoFile(
      repo.repoRoot,
      'docs/stack.md',
      contentFor('docs/stack.md'),
    );
    await repo.run(['add', 'docs/stack.md']);
    await repo.run(['commit', '-q', '-m', 'docs: note stack surgery workflow']);
  }

  const betaTestSummary =
    summaries.find(summary => summary.startsWith('test')) ??
    'test: more coverage';
  if (!omitFiles.has('beta/stack.test.js')) {
    await writeRepoFile(
      repo.repoRoot,
      'beta/stack.test.js',
      contentFor('beta/stack.test.js'),
    );
    await repo.run(['add', 'beta/stack.test.js']);
    await repo.run(['commit', '-q', '-m', betaTestSummary]);
  }
};

/**
 * @param {Awaited<ReturnType<typeof provisionStackSurgeryRepo>>} repo
 */
const assertOutcome = repo =>
  assertStackSurgeryOutcome({
    git: repo.git,
    readText,
    expected: {
      files: EXPECTED_STACK_SURGERY_FILES,
      summaries: EXPECTED_STACK_SURGERY_SUMMARIES,
    },
  });

test('stack-surgery outcome passes for the expected final stack', async t => {
  const repo = await provisionStackSurgeryRepo(t);
  await writeFinalStack(repo);

  const outcome = await assertOutcome(repo);

  t.true(
    outcome.pass,
    `expected pass; checks: ${JSON.stringify(outcome.checks, null, 2)}`,
  );
});

test('stack-surgery outcome fails when a fixup commit remains', async t => {
  const repo = await provisionStackSurgeryRepo(t);
  await writeFinalStack(repo);
  await repo.run([
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    'fixup! feat(beta): update stack surgery support',
  ]);

  const outcome = await assertOutcome(repo);

  t.false(outcome.pass);
  const byName = Object.fromEntries(outcome.checks.map(c => [c.name, c.ok]));
  t.false(byName['no-fixup-commits']);
  t.false(byName['final-stack-summaries']);
});

test('stack-surgery outcome fails when the mixed commit was never split', async t => {
  const repo = await provisionStackSurgeryRepo(t);
  await repo.run(['reset', '--hard', 'main']);
  const alphaContent = EXPECTED_STACK_SURGERY_FILES.find(
    entry => entry.path === 'alpha/index.js',
  )?.content;
  const betaContent = EXPECTED_STACK_SURGERY_FILES.find(
    entry => entry.path === 'beta/index.js',
  )?.content;
  if (alphaContent === undefined || betaContent === undefined) {
    throw new Error('missing expected alpha or beta fixture content');
  }
  await writeRepoFile(repo.repoRoot, 'alpha/index.js', alphaContent);
  await writeRepoFile(repo.repoRoot, 'beta/index.js', betaContent);
  await repo.run(['add', 'alpha/index.js', 'beta/index.js']);
  await repo.run(['commit', '-q', '-m', 'feat: update alpha and beta stack']);
  await writeFinalStack(repo, {
    summaries: EXPECTED_STACK_SURGERY_SUMMARIES.filter(
      summary =>
        summary !== 'feat(alpha): update stack surgery support' &&
        summary !== 'feat(beta): update stack surgery support',
    ),
    reset: false,
  });

  const outcome = await assertOutcome(repo);

  t.false(outcome.pass);
  const byName = Object.fromEntries(outcome.checks.map(c => [c.name, c.ok]));
  t.false(byName['mixed-commit-split']);
  t.false(byName['final-stack-summaries']);
});

test('stack-surgery outcome fails when the beta test commit is not reworded', async t => {
  const repo = await provisionStackSurgeryRepo(t);
  await writeFinalStack(repo, {
    summaries: [
      ...EXPECTED_STACK_SURGERY_SUMMARIES.slice(0, -1),
      'test: more coverage',
    ],
  });

  const outcome = await assertOutcome(repo);

  t.false(outcome.pass);
  const byName = Object.fromEntries(outcome.checks.map(c => [c.name, c.ok]));
  t.false(byName['beta-test-reworded']);
  t.false(byName['final-stack-summaries']);
});

test('stack-surgery outcome fails when a side-branch commit is missing', async t => {
  const repo = await provisionStackSurgeryRepo(t);
  await writeFinalStack(repo, {
    summaries: EXPECTED_STACK_SURGERY_SUMMARIES.filter(
      summary => summary !== 'feat(gamma): add tooling helper',
    ),
    omitFiles: new Set(['gamma/tooling.js']),
  });

  const outcome = await assertOutcome(repo);

  t.false(outcome.pass);
  const byName = Object.fromEntries(outcome.checks.map(c => [c.name, c.ok]));
  t.false(byName['final-stack-summaries']);
  t.false(byName['gamma/tooling.js-tracked-at-head']);
});

test('outcome assertion passes when the scripted run performs the stack surgery', async t => {
  const repo = await provisionStackSurgeryRepo(t);
  const scenario = makeStackSurgeryScenario();
  const model = evaluateOnceModel(
    t,
    stackSurgerySource({
      topicBranch: 'topic/stack-surgery',
      reworkBranch: 'rework/stack-surgery',
      mixedSummary: 'feat: update alpha and beta stack',
      splitCommits: [
        {
          path: 'alpha/index.js',
          summary: 'feat(alpha): update stack surgery support',
        },
        {
          path: 'beta/index.js',
          summary: 'feat(beta): update stack surgery support',
        },
      ],
      sideBranches: ['side/gamma-tooling', 'side/docs-note'],
      betaTestSummary: 'test(beta): cover stack surgery',
    }),
  );

  const { outcome } = await runGitScenario({
    model,
    workspace: repo.workspace,
    git: repo.git,
    scenario,
    readText,
  });

  t.true(
    outcome.pass,
    `expected pass; checks: ${JSON.stringify(outcome.checks, null, 2)}`,
  );
  t.deepEqual(
    outcome.checks.map(c => [c.name, c.ok]),
    [
      ['linear-on-main', true],
      ['final-stack-summaries', true],
      ['no-fixup-commits', true],
      ['mixed-commit-split', true],
      ['beta-test-reworded', true],
      ['alpha/index.js-tracked-at-head', true],
      ['alpha/index.js-content', true],
      ['beta/index.js-tracked-at-head', true],
      ['beta/index.js-content', true],
      ['beta/stack.test.js-tracked-at-head', true],
      ['beta/stack.test.js-content', true],
      ['gamma/tooling.js-tracked-at-head', true],
      ['gamma/tooling.js-content', true],
      ['docs/stack.md-tracked-at-head', true],
      ['docs/stack.md-content', true],
      ['worktree-clean', true],
    ],
  );
});

test('outcome assertion fails when the scripted run never touches the stack', async t => {
  const repo = await provisionStackSurgeryRepo(t);
  const scenario = makeStackSurgeryScenario();
  const model = fauxModel(t, [
    fauxAssistantMessage('I will not touch the repository.'),
  ]);

  const { outcome } = await runGitScenario({
    model,
    workspace: repo.workspace,
    git: repo.git,
    scenario,
    readText,
  });

  t.false(outcome.pass);
  const byName = Object.fromEntries(outcome.checks.map(c => [c.name, c.ok]));
  t.false(byName['final-stack-summaries']);
  t.false(byName['no-fixup-commits']);
  t.false(byName['mixed-commit-split']);
  t.true(byName['worktree-clean']);
});

test('stack-surgery outcome fails when the worktree is dirty', async t => {
  const repo = await provisionStackSurgeryRepo(t);
  await writeFinalStack(repo);
  await writeRepoFile(repo.repoRoot, 'docs/stack.md', '# Dirty\n');

  const outcome = await assertOutcome(repo);

  t.false(outcome.pass);
  const byName = Object.fromEntries(outcome.checks.map(c => [c.name, c.ok]));
  t.false(byName['worktree-clean']);
});
