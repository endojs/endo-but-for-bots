import '@endo/init/debug.js';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import test from 'ava';

import { discoverSkills, listSkillDirectories } from '../src/node.js';

/** @param {import('ava').ExecutionContext} t */
const makeRoot = async t => {
  const root = await mkdtemp(join(tmpdir(), 'skills-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

/**
 * @param {string} directory
 * @param {string} description
 */
const writeSkill = async (directory, description) => {
  const path = join(directory, 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  const name = directory.split('/').at(-1);
  await writeFile(
    path,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
  );
};

test('directories run from other harnesses to user to project', async t => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const repository = join(root, 'repository');
  const workingDirectory = join(repository, 'packages', 'x');
  await mkdir(join(repository, '.git'), { recursive: true });
  await mkdir(workingDirectory, { recursive: true });

  t.deepEqual(
    await listSkillDirectories({ homeDirectory: home, workingDirectory }),
    [
      join(home, '.claude/skills'),
      join(home, '.codex/skills'),
      join(home, '.pi/agent/skills'),
      join(home, '.agents/skills'),
      join(repository, '.agents/skills'),
      join(repository, 'packages/.agents/skills'),
      join(workingDirectory, '.agents/skills'),
      join(workingDirectory, '.claude/skills'),
      join(workingDirectory, '.pi/skills'),
    ],
  );
});

test('crossHarness: false scans only the Pi and agents directories', async t => {
  const home = await makeRoot(t);
  const workingDirectory = join(home, 'a');
  await mkdir(workingDirectory, { recursive: true });
  t.deepEqual(
    await listSkillDirectories({
      homeDirectory: home,
      workingDirectory,
      crossHarness: false,
    }),
    [
      join(home, '.pi/agent/skills'),
      join(home, '.agents/skills'),
      join(workingDirectory, '.agents/skills'),
      join(workingDirectory, '.pi/skills'),
    ],
  );
});

test('discovery loads real skill directories with project precedence', async t => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await writeSkill(join(home, '.claude/skills/shared'), 'from claude');
  await writeSkill(join(home, '.claude/skills/claude-only'), 'claude only');
  await writeSkill(join(project, '.agents/skills/shared'), 'from project');
  await mkdir(join(project, '.pi/skills/empty-dir'), { recursive: true });
  await writeFile(join(project, '.pi/skills/stray.md'), 'not a skill');

  const { skills, diagnostics } = await discoverSkills({
    homeDirectory: home,
    workingDirectory: project,
  });
  t.deepEqual(
    skills.map(({ name, description, filePath, baseDir }) => [
      name,
      description,
      filePath,
      baseDir,
    ]),
    [
      [
        'claude-only',
        'claude only',
        join(home, '.claude/skills/claude-only/SKILL.md'),
        join(home, '.claude/skills/claude-only'),
      ],
      [
        'shared',
        'from project',
        join(project, '.agents/skills/shared/SKILL.md'),
        join(project, '.agents/skills/shared'),
      ],
    ],
  );
  t.deepEqual(
    diagnostics.map(({ severity, entryName }) => [severity, entryName]),
    [['warning', 'shared']],
  );
});

test('discovery with no directories finds nothing', async t => {
  const root = await makeRoot(t);
  t.deepEqual(
    await discoverSkills({
      homeDirectory: join(root, 'home'),
      workingDirectory: root,
    }),
    { skills: [], diagnostics: [] },
  );
});

test('the home directory as working directory lists each directory once', async t => {
  const home = await makeRoot(t);
  const expected = [
    join(home, '.claude/skills'),
    join(home, '.codex/skills'),
    join(home, '.pi/agent/skills'),
    join(home, '.agents/skills'),
    join(home, '.pi/skills'),
  ];
  t.deepEqual(
    await listSkillDirectories({
      homeDirectory: home,
      workingDirectory: home,
    }),
    expected,
  );

  await writeSkill(join(home, '.claude/skills/once'), 'loaded once');
  const { skills, diagnostics } = await discoverSkills({
    homeDirectory: home,
    workingDirectory: home,
  });
  t.deepEqual(
    skills.map(({ name }) => name),
    ['once'],
  );
  t.deepEqual(diagnostics, []);
});

test('an unreadable directory or SKILL.md is a diagnostic, not a failure', async t => {
  const root = await makeRoot(t);
  // A path component over the file system's limit fails with ENAMETOOLONG,
  // which unlike a permissions error also holds when the tests run as root.
  const home = join(root, 'x'.repeat(300));
  const project = join(root, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await writeSkill(join(project, '.agents/skills/good'), 'still loads');
  await mkdir(join(project, '.agents/skills/bad/SKILL.md'), {
    recursive: true,
  });

  const { skills, diagnostics } = await discoverSkills({
    homeDirectory: home,
    workingDirectory: project,
  });
  t.deepEqual(
    skills.map(({ name }) => name),
    ['good'],
  );
  // Sources load concurrently, so diagnostics arrive in completion order.
  t.deepEqual(
    diagnostics
      .map(({ severity, source, entryName, message }) => [
        severity,
        source,
        entryName,
        /ENAMETOOLONG|EISDIR/.exec(message)?.[0],
      ])
      .sort(),
    [
      ['error', join(project, '.agents/skills'), 'bad', 'EISDIR'],
      ['error', join(home, '.agents/skills'), undefined, 'ENAMETOOLONG'],
      ['error', join(home, '.claude/skills'), undefined, 'ENAMETOOLONG'],
      ['error', join(home, '.codex/skills'), undefined, 'ENAMETOOLONG'],
      ['error', join(home, '.pi/agent/skills'), undefined, 'ENAMETOOLONG'],
    ],
  );
});

test('a working directory that cannot be examined rejects', async t => {
  const root = await makeRoot(t);
  await t.throwsAsync(
    () =>
      listSkillDirectories({
        homeDirectory: join(root, 'home'),
        workingDirectory: join(root, 'x'.repeat(300)),
      }),
    { code: 'ENAMETOOLONG' },
  );
});
