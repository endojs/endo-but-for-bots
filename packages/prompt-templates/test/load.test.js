import '@endo/init/debug.js';

import test from 'ava';

import { loadPromptTemplates, MAX_TEMPLATE_LENGTH } from '../src/load.js';

/**
 * @param {string} label
 * @param {Record<string, string>} files
 */
const makeSource = (label, files) => ({
  label,
  list: async () => Object.keys(files),
  /** @param {string} entryName */
  readText: async entryName => files[entryName],
});

test('loads markdown entries sorted by name and ignores others', async t => {
  const { templates, diagnostics } = await loadPromptTemplates([
    makeSource('a', {
      'z.md': 'Z',
      'b.md': 'B',
      'notes.txt': 'N',
      extensionless: 'C',
    }),
  ]);
  t.deepEqual(
    templates.map(({ name, source }) => [name, source]),
    [
      ['b', 'a'],
      ['z', 'a'],
    ],
  );
  t.deepEqual(diagnostics, []);
});

test('a later source overrides an earlier one by name', async t => {
  const { templates } = await loadPromptTemplates([
    makeSource('low', { 'x.md': 'low x', 'y.md': 'low y' }),
    makeSource('high', { 'x.md': 'high x' }),
  ]);
  t.deepEqual(
    templates.map(({ name, body }) => [name, body]),
    [
      ['x', 'high x'],
      ['y', 'low y'],
    ],
  );
});

test('precedence follows source order, not completion order', async t => {
  const { templates } = await loadPromptTemplates([
    {
      label: 'low-and-slow',
      list: async () => ['x.md'],
      readText: async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return 'low';
      },
    },
    makeSource('high', { 'x.md': 'high' }),
  ]);
  t.is(templates[0].body, 'high');
});

test('an unusable name is reported and skipped', async t => {
  const { templates, diagnostics } = await loadPromptTemplates([
    makeSource('s', {
      '.hidden.md': 'H',
      'has space.md': 'S',
      'a.b.md': 'D',
      '.md': 'E',
      'ok_1-x.md': 'K',
    }),
  ]);
  t.deepEqual(
    templates.map(({ name }) => name),
    ['ok_1-x'],
  );
  t.deepEqual(diagnostics.map(({ entryName }) => entryName).sort(), [
    '.hidden.md',
    '.md',
    'a.b.md',
    'has space.md',
  ]);
});

test('an unreadable file does not stop its siblings', async t => {
  const { templates, diagnostics } = await loadPromptTemplates([
    {
      label: 's',
      list: async () => ['bad.md', 'good.md'],
      /** @param {string} entryName */
      readText: async entryName => {
        if (entryName === 'bad.md') {
          throw Error('is a directory');
        }
        return 'G';
      },
    },
  ]);
  t.deepEqual(
    templates.map(({ name }) => name),
    ['good'],
  );
  t.is(diagnostics.length, 1);
  t.is(diagnostics[0].entryName, 'bad.md');
  t.regex(diagnostics[0].message, /is a directory/);
});

test('an unlistable source does not stop the others', async t => {
  const { templates, diagnostics } = await loadPromptTemplates([
    {
      label: 'broken',
      list: async () => {
        throw Error('revoked');
      },
      readText: async () => '',
    },
    makeSource('fine', { 'x.md': 'X' }),
  ]);
  t.deepEqual(
    templates.map(({ name }) => name),
    ['x'],
  );
  t.is(diagnostics[0].source, 'broken');
  t.regex(diagnostics[0].message, /revoked/);
});

test('a template over the length limit is reported and skipped', async t => {
  const { templates, diagnostics } = await loadPromptTemplates([
    makeSource('s', {
      'max.md': 'x'.repeat(MAX_TEMPLATE_LENGTH),
      'over.md': 'x'.repeat(MAX_TEMPLATE_LENGTH + 1),
    }),
  ]);
  t.deepEqual(
    templates.map(({ name }) => name),
    ['max'],
  );
  t.is(diagnostics[0].entryName, 'over.md');
});
