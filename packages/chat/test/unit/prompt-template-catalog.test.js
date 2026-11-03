// @ts-nocheck - Unit test with a stubbed daemon surface
// prefer-endo-primitives-exempt: the template trees are stubs of daemon mounts,
// so an interface guard here would check nothing the code under test relies on.

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/far';
import {
  makePromptTemplateCatalog,
  PROMPT_TEMPLATES_PET_NAME,
} from '@endo/spaces-util/prompt-template-catalog.js';
import { makeMockPowers } from '../helpers/mock-powers.js';

const makeTree = files =>
  Far('Tree', {
    list: () => Object.keys(files),
    readText: name => files[name],
  });

const makeDirectory = trees =>
  Far('Directory', {
    list: () => Object.keys(trees),
    lookup: name => trees[name],
  });

const makeCatalog = trees => {
  const warnings = [];
  const { powers, setValue } = makeMockPowers();
  if (trees) {
    setValue(PROMPT_TEMPLATES_PET_NAME, makeDirectory(trees));
  }
  const catalog = makePromptTemplateCatalog({
    powers,
    warn: (...messages) => warnings.push(messages.join(' ')),
  });
  return { catalog, warnings, powers, setValue };
};

test('an agent without the directory has no templates or warnings', async t => {
  const { catalog, warnings } = makeCatalog();
  await catalog.refresh();
  t.deepEqual(catalog.getCommands(), []);
  t.deepEqual(warnings, []);
});

test('a template becomes an inline command with one field per variable', async t => {
  const { catalog } = makeCatalog({
    'source-000': makeTree({
      'review.md': '---\ndescription: Review\n---\n{{focus}} {{depth}}',
    }),
  });
  await catalog.refresh();
  t.deepEqual(catalog.getCommand('review'), {
    name: 'review',
    label: 'review',
    description: 'Review',
    category: 'templates',
    mode: 'inline',
    submitLabel: 'Expand',
    fields: [
      { name: 'focus', label: 'focus', type: 'text', required: true },
      { name: 'depth', label: 'depth', type: 'text', required: true },
    ],
  });
  t.is(catalog.getTemplate('review').body, '{{focus}} {{depth}}');
  t.deepEqual(
    catalog.getCommands().map(({ name }) => name),
    ['review'],
  );
});

test('sources apply in sorted order regardless of listing order', async t => {
  const { catalog } = makeCatalog({
    'source-001': makeTree({ 'x.md': 'high' }),
    'source-000': makeTree({ 'x.md': 'low' }),
  });
  await catalog.refresh();
  t.is(catalog.getTemplate('x').body, 'high');
});

test('a template cannot take a built-in command name or alias', async t => {
  const { catalog, warnings } = makeCatalog({
    'source-000': makeTree({ 'clear.md': 'spoof', 'mine.md': 'kept' }),
  });
  await catalog.refresh();
  t.is(catalog.getTemplate('clear'), undefined);
  t.is(catalog.getCommand('clear'), undefined);
  t.is(catalog.getTemplate('mine').body, 'kept');
  t.is(warnings.length, 1);
  t.regex(warnings[0], /clear\.md: reserved name/);
});

test('a refresh picks up changed files and removals', async t => {
  const files = { 'a.md': 'A' };
  const { catalog } = makeCatalog({ 'source-000': makeTree(files) });
  await catalog.refresh();
  t.is(catalog.getTemplate('a').body, 'A');

  files['a.md'] = 'A2';
  files['b.md'] = 'B';
  await catalog.refresh();
  t.is(catalog.getTemplate('a').body, 'A2');
  t.is(catalog.getTemplate('b').body, 'B');

  delete files['a.md'];
  await catalog.refresh();
  t.is(catalog.getTemplate('a'), undefined);
  t.is(catalog.getCommand('a'), undefined);
});

test('a failed refresh keeps the previous catalog and warns', async t => {
  let broken = false;
  const directory = Far('Directory', {
    list: () => {
      if (broken) {
        throw Error('disconnected');
      }
      return ['source-000'];
    },
    lookup: () => makeTree({ 'a.md': 'A' }),
  });
  const warnings = [];
  const { powers, setValue } = makeMockPowers();
  setValue(PROMPT_TEMPLATES_PET_NAME, directory);
  const catalog = makePromptTemplateCatalog({
    powers,
    warn: (...messages) => warnings.push(messages.join(' ')),
  });
  await catalog.refresh();
  broken = true;
  await catalog.refresh();
  t.is(catalog.getTemplate('a').body, 'A');
  t.regex(warnings[0], /disconnected/);
});

test('an older refresh finishing last does not replace a newer one', async t => {
  /** @type {Array<() => void>} */
  const releases = [];
  let body = 'old';
  const directory = Far('Directory', {
    list: () => ['source-000'],
    lookup: () => {
      const captured = body;
      return Far('Tree', {
        list: () => ['a.md'],
        readText: () =>
          new Promise(resolve => {
            releases.push(() => resolve(captured));
          }),
      });
    },
  });
  const { powers, setValue } = makeMockPowers();
  setValue(PROMPT_TEMPLATES_PET_NAME, directory);
  const catalog = makePromptTemplateCatalog({ powers, warn: () => {} });

  const older = catalog.refresh();
  while (releases.length < 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  body = 'new';
  const newer = catalog.refresh();
  while (releases.length < 2) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  releases[1]();
  await newer;
  releases[0]();
  await older;
  t.is(catalog.getTemplate('a').body, 'new');
});

test('skipped files and unreadable sources warn, and the rest still load', async t => {
  const { catalog, warnings } = makeCatalog({
    'source-000': makeTree({ 'kept.md': 'Kept', 'bad name.md': 'Skipped' }),
    'source-001': Far('Tree', {
      list: () => {
        throw Error('unreadable');
      },
      readText: () => '',
    }),
  });
  await catalog.refresh();
  t.deepEqual(
    catalog.getCommands().map(({ name }) => name),
    ['kept'],
  );
  t.is(warnings.length, 2);
  t.true(
    warnings.some(warning =>
      warning.startsWith('Skipped prompt template source-000/bad name.md: '),
    ),
  );
  t.true(
    warnings.some(
      warning =>
        warning.startsWith('Skipped prompt template source-001/: ') &&
        warning.includes('unreadable'),
    ),
  );
});
