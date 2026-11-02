import '@endo/init/debug.js';

import test from 'ava';

import { parsePromptTemplate } from '../src/parse.js';

/** @param {string} text */
const parse = text =>
  parsePromptTemplate({ name: 'review', text, source: 'test' });

test('a plain file is all body, described by its first line', t => {
  t.deepEqual(parse('\n\nReview for bugs.\nFocus on: {{focus}}\n'), {
    name: 'review',
    description: 'Review for bugs.',
    body: 'Review for bugs.\nFocus on: {{focus}}',
    variables: ['focus'],
    source: 'test',
  });
});

test('frontmatter supplies the description and leaves the body', t => {
  const template = parse(
    '---\nargument-hint: "<x>"\ndescription: Review staged changes\n---\n\nBody {{x}}\n',
  );
  t.is(template.description, 'Review staged changes');
  t.is(template.body, 'Body {{x}}');
  t.deepEqual(template.variables, ['x']);
});

test('a placeholder in frontmatter is not a variable', t => {
  t.deepEqual(parse('---\ndescription: {{no}}\n---\nBody').variables, []);
});

test('quotes around a frontmatter description are removed', t => {
  t.is(parse('---\ndescription: "a: b"\n---\nBody').description, 'a: b');
  t.is(parse("---\ndescription: 'c'\n---\nBody").description, 'c');
});

test('frontmatter without a usable description falls back to the body', t => {
  t.is(parse('---\nother: x\n---\nFirst\n').description, 'First');
  t.is(parse('---\ndescription:\n---\nFirst\n').description, 'First');
  t.is(parse('---\ndescription: |\n  a\n---\nFirst\n').description, 'First');
  t.is(parse('---\n---\nFirst\n').description, 'First');
});

test('an unclosed frontmatter fence is body text', t => {
  const template = parse('---\ndescription: x\nBody');
  t.is(template.body, '---\ndescription: x\nBody');
  t.is(template.description, '---');
});

test('a fence later in the file is not frontmatter', t => {
  t.is(parse('Intro\n---\ndescription: x\n---\n').description, 'Intro');
});

test('a BOM and CRLF line endings are normalized', t => {
  const template = parse(
    '\uFEFF---\r\ndescription: D\r\n---\r\nOne\r\nTwo\r\n',
  );
  t.is(template.description, 'D');
  t.is(template.body, 'One\nTwo');
});

test('a long first line is truncated in the description only', t => {
  const line = 'x'.repeat(61);
  const template = parse(line);
  t.is(template.description, `${'x'.repeat(60)}...`);
  t.is(template.body, line);
  t.is(parse('y'.repeat(60)).description, 'y'.repeat(60));
});

test('a skill reference in the body passes through literally', t => {
  t.is(parse('Then use `/skill:gh-cli`.').body, 'Then use `/skill:gh-cli`.');
});

test('an empty file yields an empty template', t => {
  const template = parse('');
  t.is(template.body, '');
  t.is(template.description, '');
  t.deepEqual(template.variables, []);
});
