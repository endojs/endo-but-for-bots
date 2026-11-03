import '@endo/init/debug.js';

import test from 'ava';

import {
  parseFrontmatter,
  parseSkill,
  splitFrontmatter,
  validateSkillName,
} from '../src/parse.js';

/**
 * @param {string} text
 * @param {string} [directoryName]
 */
const parse = (text, directoryName = 'my-skill') =>
  parseSkill({
    directoryName,
    text,
    filePath: `/s/${directoryName}/SKILL.md`,
    baseDir: `/s/${directoryName}`,
    source: '/s',
  });

test('parses the agentskills.io fields', t => {
  const { skill, diagnostics } = parse(
    [
      '---',
      'name: my-skill',
      'description: "Does a thing: well."',
      'license: MIT',
      'compatibility: Requires git, bash.',
      'allowed-tools: read bash',
      'disable-model-invocation: true',
      'metadata:',
      '  author: someone',
      "  version: '1.0'",
      '---',
      '',
      '# My Skill',
      '',
      'Body.',
    ].join('\n'),
  );
  t.deepEqual(diagnostics, []);
  t.deepEqual(skill, {
    name: 'my-skill',
    description: 'Does a thing: well.',
    filePath: '/s/my-skill/SKILL.md',
    baseDir: '/s/my-skill',
    source: '/s',
    license: 'MIT',
    compatibility: 'Requires git, bash.',
    allowedTools: ['read', 'bash'],
    disableModelInvocation: true,
    metadata: { author: 'someone', version: '1.0' },
  });
  t.true(Object.isFrozen(skill));
});

test('block scalars fold or keep lines', t => {
  t.deepEqual(
    parseFrontmatter(
      [
        'description: >-',
        '  Folded across',
        '  two lines.',
        'notes: |',
        '  line one',
        '  line two',
        'plain: starts here',
        '  and continues',
      ].join('\n'),
    ),
    {
      description: 'Folded across two lines.',
      notes: 'line one\nline two',
      plain: 'starts here and continues',
    },
  );
});

test('lines that are not keys are skipped with anything indented under them', t => {
  t.deepEqual(
    parseFrontmatter(
      [
        '# a comment',
        'name: kept',
        '- list item',
        '  nested: ignored',
        'description: also kept',
      ].join('\n'),
    ),
    { name: 'kept', description: 'also kept' },
  );
});

test('a skill without a description does not load', t => {
  const { skill, diagnostics } = parse('---\nname: my-skill\n---\nBody');
  t.is(skill, undefined);
  t.is(diagnostics.length, 1);
  t.is(diagnostics[0].severity, 'error');
  t.is(parse('No frontmatter at all.').skill, undefined);
});

test('violations warn but the skill still loads', t => {
  const { skill, diagnostics } = parse(
    `---\nname: Other_Skill\ndescription: ${'x'.repeat(1025)}\n---\n`,
  );
  t.is(skill?.name, 'Other_Skill');
  t.deepEqual(
    diagnostics.map(({ severity }) => severity),
    ['warning', 'warning', 'warning'],
  );
  t.regex(diagnostics[0].message, /exceeds 1024/);
  t.regex(diagnostics[1].message, /does not match directory/);
  t.regex(diagnostics[2].message, /lowercase/);
});

test('a missing name falls back to the directory name', t => {
  const { skill, diagnostics } = parse('---\ndescription: d\n---\n', 'dir');
  t.is(skill?.name, 'dir');
  t.is(diagnostics.length, 1);
  t.regex(diagnostics[0].message, /no name/);
});

test('name rules', t => {
  t.deepEqual(validateSkillName('pdf-tools2'), []);
  for (const name of ['-a', 'a-', 'a--b', 'A', 'a_b', 'a'.repeat(65), '']) {
    t.not(validateSkillName(name).length, 0, name);
  }
});

test('splitFrontmatter handles CRLF, BOM, and an unclosed fence', t => {
  t.deepEqual(splitFrontmatter('﻿---\r\nname: a\r\n---\r\n\r\nBody\r\n'), {
    frontmatter: 'name: a',
    body: 'Body',
  });
  t.deepEqual(splitFrontmatter('---\nname: a\nBody'), {
    frontmatter: undefined,
    body: '---\nname: a\nBody',
  });
});
