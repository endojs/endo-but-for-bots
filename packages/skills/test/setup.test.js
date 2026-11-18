import '@endo/init/debug.js';

import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import test from 'ava';

import {
  installSkillMounts,
  isSetupEntryName,
  planSkillMounts,
} from '../src/setup.js';

const makeTree = async () => {
  const root = await mkdtemp(join(tmpdir(), 'endo-skills-setup-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  for (const directory of [
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.agents', 'skills'),
    join(work, '.git'),
    join(work, '.agents', 'skills'),
    join(work, '.pi', 'skills'),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(directory, { recursive: true });
  }
  return { home, work };
};

test('plans one mount per existing directory, in precedence order', async t => {
  const { home, work } = await makeTree();
  const plan = await planSkillMounts({
    homeDirectory: home,
    workingDirectory: work,
  });
  t.deepEqual(
    plan.map(({ entryName }) => entryName),
    [
      '00-claude-user',
      '01-codex-user',
      '03-agents-user',
      '04-agents-project-0',
      '06-pi-project',
    ],
  );
  const names = plan.map(({ entryName }) => entryName);
  t.deepEqual([...names].sort(), names);
  t.true(names.every(isSetupEntryName));
});

test('--no-cross-harness skips the Claude Code and Codex directories', async t => {
  const { home, work } = await makeTree();
  const plan = await planSkillMounts({
    homeDirectory: home,
    workingDirectory: work,
    crossHarness: false,
  });
  t.false(plan.some(({ entryName }) => /claude|codex/.test(entryName)));
  t.is(plan.length, 3);
});

test('rerunning replaces its own entries and leaves others alone', async t => {
  /** @type {Map<string, unknown>} */
  const entries = new Map([
    ['00-claude-user', 'old'],
    ['my-own-mount', 'kept'],
  ]);
  /** @type {unknown[]} */
  const calls = [];
  const host = {
    has: async () => true,
    makeDirectory: async () => {
      throw Error('unexpected');
    },
    list: async () => [...entries.keys()],
    /** @param {string[]} path */
    remove: async (...path) => {
      entries.delete(path[path.length - 1]);
    },
    /**
     * @param {string} directory
     * @param {string[]} path
     * @param {{ readOnly: boolean }} options
     */
    provideMount: async (directory, path, options) => {
      calls.push({ directory, path, options });
      entries.set(path[path.length - 1], directory);
    },
  };
  const result = await installSkillMounts({
    host,
    agentName: 'lal',
    mounts: [{ entryName: '02-pi-user', directory: '/h/.pi/agent/skills' }],
  });
  t.deepEqual(result, { removed: ['00-claude-user'], added: ['02-pi-user'] });
  t.deepEqual([...entries.keys()].sort(), ['02-pi-user', 'my-own-mount']);
  t.deepEqual(calls, [
    {
      directory: '/h/.pi/agent/skills',
      path: ['lal', 'agent-skills', '02-pi-user'],
      options: { readOnly: true },
    },
  ]);
});
