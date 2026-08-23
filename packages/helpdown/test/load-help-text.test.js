// @ts-check

import test from 'ava';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadHelpTextFile, readHelpTextFileSync } from '../tools.js';

/**
 * Write a helpdown document to a fresh temporary directory that is removed
 * when the test ends.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {string} name
 * @param {string[]} lines
 * @returns {URL}
 */
const writeHelpFile = (t, name, lines) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'helpdown-test-'));
  t.teardown(() => rmSync(tmpDir, { recursive: true, force: true }));
  const tmpFile = join(tmpDir, name);
  writeFileSync(tmpFile, lines.join('\n'));
  return pathToFileURL(tmpFile);
};

test('readHelpTextFileSync reads and parses a markdown file', t => {
  const url = writeHelpFile(t, 'test-help.md', [
    '# TestEntity - A test entity.',
    '',
    '## foo()',
    'Does foo.',
  ]);
  const helpMap = readHelpTextFileSync(url);
  t.true(helpMap instanceof Map);
  const help = helpMap.get('TestEntity');
  if (help === undefined) {
    t.fail('expected a TestEntity entry');
    return;
  }
  t.is(help[''], 'TestEntity - A test entity.');
  t.true(help.foo.includes('Does foo.'));
});

test('loadHelpTextFile returns async iterable of entries', async t => {
  const url = writeHelpFile(t, 'async-help.md', [
    '# Alpha - First.',
    '',
    '## a()',
    'Method a.',
    '',
    '# Beta - Second.',
    '',
    '## b()',
    'Method b.',
  ]);
  /** @type {Array<[string, Record<string, string>]>} */
  const results = [];
  for await (const entry of loadHelpTextFile(url)) {
    results.push(entry);
  }
  t.is(results.length, 2);
  t.is(results[0][0], 'Alpha');
  t.is(results[1][0], 'Beta');
  t.true(results[0][1].a.includes('Method a.'));
  t.true(results[1][1].b.includes('Method b.'));
});
