import '@endo/init/debug.js';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';

import test from 'ava';

import {
  discoverPromptTemplates,
  listPromptTemplateDirectories,
} from '../src/node.js';

/** @param {import('ava').ExecutionContext} t */
const makeRoot = async t => {
  const root = await mkdtemp(join(tmpdir(), 'prompt-templates-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

/**
 * @param {string} path
 * @param {string} text
 */
const writeTemplate = async (path, text) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

test('directories run from user to repository root to working directory', async t => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const repository = join(root, 'repository');
  const workingDirectory = join(repository, 'packages', 'x');
  await mkdir(join(repository, '.git'), { recursive: true });
  await mkdir(workingDirectory, { recursive: true });

  t.deepEqual(
    await listPromptTemplateDirectories({
      homeDirectory: home,
      workingDirectory,
    }),
    [
      join(home, '.pi/agent/prompts'),
      join(home, '.agents/prompts'),
      join(repository, '.agents/prompts'),
      join(repository, 'packages/.agents/prompts'),
      join(workingDirectory, '.agents/prompts'),
      join(workingDirectory, '.pi/prompts'),
    ],
  );
});

test('without a repository below home only the working directory counts', async t => {
  const home = await makeRoot(t);
  const workingDirectory = join(home, 'a', 'b');
  await mkdir(workingDirectory, { recursive: true });

  t.deepEqual(
    await listPromptTemplateDirectories({
      homeDirectory: home,
      workingDirectory,
    }),
    [
      join(home, '.pi/agent/prompts'),
      join(home, '.agents/prompts'),
      join(workingDirectory, '.agents/prompts'),
      join(workingDirectory, '.pi/prompts'),
    ],
  );
});

test('working in the home directory lists its directories once', async t => {
  const home = await makeRoot(t);
  t.deepEqual(
    await listPromptTemplateDirectories({
      homeDirectory: home,
      workingDirectory: home,
    }),
    [
      join(home, '.pi/agent/prompts'),
      join(home, '.agents/prompts'),
      join(home, '.pi/prompts'),
    ],
  );
});

test('discovery loads real files with project over global precedence', async t => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await writeTemplate(join(home, '.pi/agent/prompts/both.md'), 'global both');
  await writeTemplate(join(home, '.pi/agent/prompts/own.md'), 'global own');
  await writeTemplate(join(home, '.agents/prompts/cross.md'), 'cross {{x}}');
  await writeTemplate(join(project, '.agents/prompts/both.md'), 'agents both');
  await writeTemplate(join(project, '.pi/prompts/both.md'), 'project both');
  await mkdir(join(project, '.pi/prompts/directory.md'), { recursive: true });

  const { templates, diagnostics } = await discoverPromptTemplates({
    homeDirectory: home,
    workingDirectory: project,
  });
  t.deepEqual(
    templates.map(({ name, body }) => [name, body]),
    [
      ['both', 'project both'],
      ['cross', 'cross {{x}}'],
      ['own', 'global own'],
    ],
  );
  t.deepEqual(
    diagnostics.map(({ entryName }) => entryName),
    ['directory.md'],
  );
});

test('discovery with no directories finds nothing', async t => {
  const root = await makeRoot(t);
  t.deepEqual(
    await discoverPromptTemplates({
      homeDirectory: join(root, 'home'),
      workingDirectory: root,
    }),
    { templates: [], diagnostics: [] },
  );
});

test('with neither home nor a repository above it, only the working directory counts', async t => {
  // A path that does not exist walks to the filesystem root without finding a
  // repository, wherever the test's temporary directory happens to live.
  const workingDirectory = join(
    parse(tmpdir()).root,
    'nonexistent-prompt-templates-test',
    'a',
  );
  const home = await makeRoot(t);

  t.deepEqual(
    await listPromptTemplateDirectories({
      homeDirectory: home,
      workingDirectory,
    }),
    [
      join(home, '.pi/agent/prompts'),
      join(home, '.agents/prompts'),
      join(workingDirectory, '.agents/prompts'),
      join(workingDirectory, '.pi/prompts'),
    ],
  );
});

test('a repository search that fails for another reason than absence rejects', async t => {
  const root = await makeRoot(t);
  const file = join(root, 'file');
  await writeFile(file, '');

  await t.throwsAsync(
    listPromptTemplateDirectories({
      homeDirectory: join(root, 'home'),
      workingDirectory: join(file, 'below'),
    }),
    { code: 'ENOTDIR' },
  );
});

test('an unreadable directory yields a diagnostic and the others still load', async t => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const unreadable = join(home, '.agents/prompts');
  await writeTemplate(join(home, '.pi/agent/prompts/kept.md'), 'Kept');
  await writeTemplate(unreadable, 'a file where a directory belongs');

  const { templates, diagnostics } = await discoverPromptTemplates({
    homeDirectory: home,
    workingDirectory: join(root, 'project'),
  });

  t.deepEqual(
    templates.map(({ name }) => name),
    ['kept'],
  );
  t.is(diagnostics.length, 1);
  t.is(diagnostics[0].source, unreadable);
  t.regex(diagnostics[0].message, /ENOTDIR/);
});
