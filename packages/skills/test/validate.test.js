import '@endo/init/debug.js';

import test from 'ava';

import { parseSkill, validateSkillName } from '../src/parse.js';

/** @param {string} frontmatter */
const parse = frontmatter =>
  parseSkill({
    directoryName: 'my-skill',
    text: `---\n${frontmatter}\n---\n\nBody.\n`,
    filePath: '/s/my-skill/SKILL.md',
    baseDir: '/s/my-skill',
    source: '/s',
  });

/** @param {ReturnType<typeof parse>} result */
const messages = result => result.diagnostics.map(({ message }) => message);

test('name rules: doubled, leading, and trailing hyphens warn', t => {
  t.deepEqual(validateSkillName('my-skill'), []);
  for (const name of ['my--skill', '-my-skill', 'my-skill-', 'My-Skill']) {
    t.is(validateSkillName(name).length, 1, name);
  }
  t.is(validateSkillName('a'.repeat(65)).length, 1);
});

test('compatibility longer than 500 characters warns', t => {
  const ok = parse(
    `name: my-skill\ndescription: d\ncompatibility: ${'x'.repeat(500)}`,
  );
  t.deepEqual(ok.diagnostics, []);
  const long = parse(
    `name: my-skill\ndescription: d\ncompatibility: ${'x'.repeat(501)}`,
  );
  t.truthy(long.skill);
  t.deepEqual(messages(long), ['compatibility exceeds 500 characters']);
});

test('a non-boolean disable-model-invocation warns and counts as false', t => {
  const result = parse(
    'name: my-skill\ndescription: d\ndisable-model-invocation: yes',
  );
  t.is(result.skill?.disableModelInvocation, false);
  t.is(result.diagnostics.length, 1);
  t.is(result.diagnostics[0].severity, 'warning');
});

test('non-string metadata values are dropped with a warning', t => {
  const result = parse(
    'name: my-skill\ndescription: d\nmetadata:\n  author: me\n  tags: [a, b]\n  nested:\n    deep: x',
  );
  t.deepEqual(result.skill?.metadata, { author: 'me' });
  t.is(result.diagnostics.length, 2);
  t.true(result.diagnostics.every(({ severity }) => severity === 'warning'));
});

test('unsupported top-level YAML is ignored with a warning', t => {
  const result = parse('name: my-skill\ndescription: d\n- stray list item');
  t.truthy(result.skill);
  t.deepEqual(messages(result), [
    'ignored unsupported frontmatter line "- stray list item"',
  ]);
});

test('a foreign Claude Code skill with unknown keys loads cleanly', t => {
  const result = parse(
    'name: my-skill\ndescription: d\nmodel: opus\nuser-invocable: true\nallowed-tools: Read, Grep',
  );
  t.deepEqual(result.diagnostics, []);
  t.deepEqual(result.skill?.allowedTools, ['Read', 'Grep']);
});

test('an empty description is an error and the skill is not loaded', t => {
  const result = parse('name: my-skill\ndescription: ""');
  t.is(result.skill, undefined);
  t.is(result.diagnostics[0].severity, 'error');
});
