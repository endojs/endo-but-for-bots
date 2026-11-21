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
import { publishSource } from '../../scripts/project-preset.mjs';

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
