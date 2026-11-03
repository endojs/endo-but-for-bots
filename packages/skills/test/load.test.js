import '@endo/init/debug.js';

import test from 'ava';

import { loadSkills } from '../src/load.js';

/**
 * @param {string} label
 * @param {Record<string, string | undefined>} entries
 */
const makeSource = (label, entries) => ({
  label,
  list: async () => Object.keys(entries),
  /** @param {string} entryName */
  readSkillText: async entryName => entries[entryName],
  /** @param {string} entryName */
  locate: entryName => ({
    filePath: `${label}/${entryName}/SKILL.md`,
    baseDir: `${label}/${entryName}`,
  }),
});

/**
 * @param {string} name
 * @param {string} description
 */
const skillText = (name, description) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody`;

test('later sources override earlier ones, sorted by name', async t => {
  const { skills, diagnostics } = await loadSkills([
    makeSource('user', {
      both: skillText('both', 'user both'),
      own: skillText('own', 'user own'),
      'not-a-skill': undefined,
      '.hidden': skillText('hidden', 'hidden'),
    }),
    makeSource('project', { both: skillText('both', 'project both') }),
  ]);
  t.deepEqual(
    skills.map(({ name, description, source }) => [name, description, source]),
    [
      ['both', 'project both', 'project'],
      ['own', 'user own', 'user'],
    ],
  );
  t.deepEqual(
    diagnostics.map(({ severity, source, message }) => [
      severity,
      source,
      message,
    ]),
    [['warning', 'project', 'skill "both" overrides the one in user']],
  );
});

test('a failing source or file is a diagnostic, not a failure', async t => {
  const broken = {
    ...makeSource('broken', {}),
    list: async () => {
      throw Error('no listing');
    },
  };
  const flaky = {
    ...makeSource('flaky', { bad: 'x', good: skillText('good', 'ok') }),
    /** @param {string} entryName */
    readSkillText: async entryName => {
      if (entryName === 'bad') {
        throw Error('unreadable');
      }
      return skillText('good', 'ok');
    },
  };
  const { skills, diagnostics } = await loadSkills([broken, flaky]);
  t.deepEqual(
    skills.map(({ name }) => name),
    ['good'],
  );
  t.deepEqual(
    diagnostics.map(({ source, entryName, message }) => [
      source,
      entryName,
      message,
    ]),
    [
      ['broken', undefined, 'Error: no listing'],
      ['flaky', 'bad', 'Error: unreadable'],
    ],
  );
});
