// @ts-check
import test from 'ava';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  projectInstructions,
  publishSource,
  savePreset,
} from '../../scripts/project-preset.mjs';

const git = promisify(execFile);

test('publishing pins committed source, leaves the operator checkout alone, and rejects damaged bundles', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'thix-publish-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const state = path.join(dir, 'state');
  const pkg = path.join(repo, 'packages', 'thixotrope-harness');
  await mkdir(pkg, { recursive: true });
  await git('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(pkg, 'package.json'), '{}\n');
  await git('git', ['-C', repo, 'add', 'packages']);
  await git('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'baseline',
  ]);
  await writeFile(path.join(pkg, 'package.json'), '{"dirty":true}\n');
  const [a, b] = await Promise.all([
    publishSource(state, repo, 'HEAD'),
    publishSource(state, repo, 'main'),
  ]);
  t.deepEqual(a, b);
  t.is(
    (
      await git('git', ['-C', repo, 'for-each-ref', '--format=%(refname)'])
    ).stdout.trim(),
    'refs/heads/main',
  );
  t.is(
    await readFile(path.join(pkg, 'package.json'), 'utf8'),
    '{"dirty":true}\n',
  );
  const bundles = path.join(state, 'environments', 'projects', a.project);
  const bundle = path.join(bundles, `${a.commit}.bundle`);
  t.deepEqual(await readdir(bundles), [`${a.commit}.bundle`]);
  const check = path.join(dir, 'checkout');
  await git('git', ['clone', '--quiet', '--branch', 'seed', bundle, check]);
  t.is(
    await readFile(
      path.join(check, 'packages', 'thixotrope-harness', 'package.json'),
      'utf8',
    ),
    '{}\n',
  );
  const original = await readFile(bundle);
  await writeFile(bundle, original.subarray(0, original.length - 12));
  await t.throwsAsync(publishSource(state, repo, 'HEAD'));
});

test('all published defaults upgrade to a ten-minute cold build, preserving operator edits', t => {
  const workflow = [
    'You are developing the Thixotrope harness in your own persistent Git checkout at /workspace.',
    'On first use, run sh -c "cd /workspace && thix-selfdev-prepare" to install the locked Linux dependencies and build the worker boot bundles offline.',
    'Run package commands from /workspace/packages/thixotrope-harness. For example, run corepack yarn test test/unit/m5-w58-presets.test.js.',
    'Reproduce the issue with a focused test, edit the checkout and rerun the test. Return git diff HEAD for review.',
  ].join(' ');
  const current = projectInstructions(undefined);
  t.regex(current, /first thix-selfdev-prepare command.*timeoutMs to 600000/);
  t.is(projectInstructions(current), current);
  for (const suffix of [
    'Use a separate short /tmp state path for nested supervisors.',
    'For a nested supervisor use a short private state directory under /home/node, where its staged Linux worker can execute.',
    'For nested integration tests set THIX_HARNESS_TMP=/tmp/thix. For a separate supervisor create a short private state directory on that same Linux scratch mount.',
  ]) {
    const old = `${workflow} ${suffix}`;
    t.is(projectInstructions(old), current);
    const customized = `${old} Run my local checks.`;
    t.is(projectInstructions(customized), customized);
  }
  t.is(projectInstructions(''), '');
});

test('refreshing the same project commit removes legacy effort once', async t => {
  const seed = /** @type {const} */ ({
    project: 'thixotrope',
    commit: 'ab'.repeat(20),
  });
  /** @type {Record<string, any>} */
  let view = {
    label: 'Thixotrope development',
    template: 'development',
    workspaceSeed: seed,
    available: true,
    instructions: 'Custom instructions',
    modelId: 'custom-model',
    reasoningEffort: 'old',
  };
  let saves = 0;
  const preset = {
    describe: () => view,
    save: (/** @type {object} */ record) => {
      saves += 1;
      view = { ...record, available: true };
    },
  };
  const catalog = {
    configuration: () => ({ presets: [preset], revision: saves }),
  };
  await savePreset(catalog, {}, seed, false);
  await savePreset(catalog, {}, seed, false);
  t.is(saves, 1);
  t.false('reasoningEffort' in view);
  t.is(view.instructions, 'Custom instructions');
  t.is(view.modelId, 'custom-model');
});
