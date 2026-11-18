import '@endo/init/debug.js';

import test from 'ava';

import { loadAgentSkills } from '../src/mount.js';
import { formatSkillsForPrompt } from '../src/prompt.js';

/**
 * A stand-in for a read-only EndoMount over an in-memory tree.
 *
 * @param {Record<string, string | undefined>} files skill name -> SKILL.md text
 */
const makeFakeMount = files => ({
  list: async () => Object.keys(files),
  /** @param {string[]} segments */
  has: async (...segments) =>
    segments.length === 2 &&
    segments[1] === 'SKILL.md' &&
    files[segments[0]] !== undefined,
  /** @param {string[]} segments */
  readText: async ([entryName]) => {
    const text = files[entryName];
    if (text === undefined) throw Error('ENOENT');
    return text;
  },
});

/**
 * @param {string} name
 * @param {string} description
 */
const skillText = (name, description) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;

/** @param {Record<string, ReturnType<typeof makeFakeMount>>} entries */
const makeFakePowers = entries => ({
  /** @param {string} name */
  has: async name => name === 'agent-skills',
  list: async () => Object.keys(entries),
  /** @param {string[]} path */
  lookup: async ([, entryName]) => entries[entryName],
});

test('mount sources load with pet-name locations in entry-name order', async t => {
  const powers = makeFakePowers({
    '30-agents-project-0': makeFakeMount({
      shared: skillText('shared', 'project version'),
    }),
    '10-claude-user': makeFakeMount({
      shared: skillText('shared', 'user version'),
      solo: skillText('solo', 'only here'),
      'not-a-skill': undefined,
    }),
  });
  const { skills, diagnostics } = await loadAgentSkills(powers);
  t.deepEqual(
    skills.map(({ name, description, filePath, baseDir }) => ({
      name,
      description,
      filePath,
      baseDir,
    })),
    [
      {
        name: 'shared',
        description: 'project version',
        filePath: 'agent-skills/30-agents-project-0/shared/SKILL.md',
        baseDir: 'agent-skills/30-agents-project-0/shared',
      },
      {
        name: 'solo',
        description: 'only here',
        filePath: 'agent-skills/10-claude-user/solo/SKILL.md',
        baseDir: 'agent-skills/10-claude-user/solo',
      },
    ],
  );
  t.is(diagnostics.length, 1);
  t.is(diagnostics[0].severity, 'warning');
});

test('an agent without agent-skills has no skills', async t => {
  const { skills } = await loadAgentSkills({ has: async () => false });
  t.deepEqual(skills, []);
});

test('a host-specific read hint replaces the filesystem wording', async t => {
  const powers = makeFakePowers({
    '10-pi-user': makeFakeMount({ a: skillText('a', 'desc </skill> x') }),
  });
  const { skills } = await loadAgentSkills(powers);
  const prompt = formatSkillsForPrompt(skills, {
    readHint: 'Read a skill with readText(location).',
  });
  t.true(prompt.includes('Read a skill with readText(location).'));
  t.false(prompt.includes('read tool'));
  t.false(prompt.includes('</skill> x'));
  t.true(prompt.includes('&lt;/skill&gt; x'));
  t.true(
    prompt.includes('<location>agent-skills/10-pi-user/a/SKILL.md</location>'),
  );
});
