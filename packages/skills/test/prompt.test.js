import '@endo/init/debug.js';

import test from 'ava';

import {
  expandSkillCommand,
  formatSkillsForPrompt,
  parseSkillCommand,
} from '../src/prompt.js';

/**
 * @param {string} name
 * @param {string} description
 * @param {boolean} [disableModelInvocation]
 */
const makeSkill = (name, description, disableModelInvocation = false) => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
  source: '/skills',
  allowedTools: [],
  disableModelInvocation,
  metadata: {},
});

test('the prompt lists names, descriptions, and locations', t => {
  const text = formatSkillsForPrompt([
    makeSkill('pdf', 'Read <PDF> & "forms".'),
    makeSkill('hidden', 'Only by command.', true),
  ]);
  t.true(text.startsWith('The following skills provide'));
  t.true(
    text.endsWith(
      [
        '<available_skills>',
        '  <skill>',
        '    <name>pdf</name>',
        '    <description>Read &lt;PDF&gt; &amp; &quot;forms&quot;.</description>',
        '    <location>/skills/pdf/SKILL.md</location>',
        '  </skill>',
        '</available_skills>',
      ].join('\n'),
    ),
  );
  t.false(text.includes('hidden'));
});

test('no visible skills renders nothing', t => {
  t.is(formatSkillsForPrompt([]), '');
  t.is(formatSkillsForPrompt([makeSkill('x', 'y', true)]), '');
});

test('parseSkillCommand', t => {
  t.deepEqual(parseSkillCommand('/skill:pdf'), { name: 'pdf', args: '' });
  t.deepEqual(parseSkillCommand('  /skill:pdf fill\nthe form '), {
    name: 'pdf',
    args: 'fill\nthe form',
  });
  t.is(parseSkillCommand('use /skill:pdf'), undefined);
  t.is(parseSkillCommand('/skill:'), undefined);
});

test('a skill command expands to the skill body and arguments', async t => {
  const skills = [makeSkill('pdf', 'd'), makeSkill('hidden', 'h', true)];
  /** @param {string} path */
  const readText = async path =>
    `---\nname: x\ndescription: d\n---\n\n# ${path}\n`;
  t.is(
    await expandSkillCommand({ text: '/skill:pdf fill it', skills, readText }),
    [
      '<skill name="pdf" location="/skills/pdf/SKILL.md">',
      'References are relative to /skills/pdf.',
      '',
      '# /skills/pdf/SKILL.md',
      '</skill>',
      '',
      'fill it',
    ].join('\n'),
  );
  t.true(
    (
      await expandSkillCommand({ text: '/skill:hidden', skills, readText })
    ).endsWith('</skill>'),
  );
  t.is(await expandSkillCommand({ text: 'hello', skills, readText }), 'hello');
  await t.throwsAsync(
    expandSkillCommand({ text: '/skill:nope', skills, readText }),
    { message: 'Unknown skill "nope"' },
  );
});
