// @ts-check

import { readFile } from 'node:fs/promises';

import test from 'ava';
import { lint } from 'markdownlint/promise';

import {
  isFullFallbackPath,
  isIntendedMarkdown,
  parseAddedLineNumbers,
} from './lint-markdown.mjs';
import sentencePerLine from './markdown-sentence-per-line.mjs';

const lintText = async (name, text) => {
  const results = await lint({
    strings: { [name]: text },
    customRules: [sentencePerLine],
    config: {
      default: false,
      'sentence-per-line': true,
    },
  });
  return results[name];
};

test('corrected and adversarial prose passes', async t => {
  const text = await readFile(
    new URL('./markdown-lint-fixtures/valid.txt', import.meta.url),
    'utf8',
  );
  t.deepEqual(await lintText('valid.md', text), []);
});

test('two sentences on one physical line fail in prose containers', async t => {
  const text = await readFile(
    new URL('./markdown-lint-fixtures/invalid.txt', import.meta.url),
    'utf8',
  );
  const errors = await lintText('invalid.md', text);
  t.deepEqual(
    errors.map(error => error.lineNumber),
    [1, 3, 5, 7, 9, 11, 13, 15, 17],
  );
  t.true(errors.every(error => error.ruleNames.includes('sentence-per-line')));
});

test('front matter is ignored without shifting physical diagnostics', async t => {
  const errors = await lintText(
    'frontmatter.md',
    [
      '---',
      ['title: One.', 'Two.'].join(' '),
      '---',
      '',
      ['First sentence.', 'Second sentence.'].join(' '),
      '',
    ].join('\n'),
  );
  t.deepEqual(
    errors.map(error => error.lineNumber),
    [5],
  );
});

test('intended corpus excludes generated, release, and fixture Markdown', t => {
  for (const path of [
    'README.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'designs/example.md',
    'docs/guide.md',
    'packages/example/README.md',
    'scripts/setup.md',
  ]) {
    t.true(isIntendedMarkdown(path), path);
  }
  for (const path of [
    '.changeset/release.md',
    'PLAN/notes.md',
    'TADA/archive.md',
    'packages/example/CHANGELOG.md',
    'packages/example/test/fixture/README.md',
    'packages/example/test/fixtures-data/README.md',
    'packages/test262-runner/test262/README.md',
    'rust/vendor/README.md',
    'scripts/markdown-lint-fixtures/invalid.md',
  ]) {
    t.false(isIntendedMarkdown(path), path);
  }
});

test('tool and CI changes trigger the full-corpus fallback', t => {
  for (const path of [
    '.node-version',
    '.prettierignore',
    '.prettierrc.json',
    '.github/workflows/ci-docs.yml',
    '.github/workflows/ci.yml',
    'package.json',
    'scripts/lint-markdown.mjs',
    'scripts/lint-markdown.test.mjs',
    'scripts/markdown-lint-fixtures/valid.txt',
    'scripts/markdown-sentence-per-line.mjs',
    'yarn.lock',
  ]) {
    t.true(isFullFallbackPath(path), path);
  }
  t.false(isFullFallbackPath('packages/example/src/example.js'));
  t.false(isFullFallbackPath('docs/example.md'));
});

test('zero-context diffs identify only new-side lines', t => {
  const diff = [
    '@@ -2 +2,2 @@',
    '-old',
    '+new',
    '+added',
    '@@ -8,2 +9 @@',
    '-old',
    '-old',
    '+replacement',
    '@@ -20 +20,0 @@',
    '-deleted',
  ].join('\n');
  t.deepEqual([...parseAddedLineNumbers(diff)], [2, 3, 9]);
});
