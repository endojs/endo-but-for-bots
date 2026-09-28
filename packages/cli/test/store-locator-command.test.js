// @ts-check

import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const endoBin = path.join(dirname, '..', 'bin', 'endo.cjs');

// `endo store --locator` is the CLI surface for the host's
// `adoptFromLocator`, folded into the existing `store` verb as one more
// exclusive mode (designs/capability-url-locators.md), distinct from
// message-attachment `adopt` and invitation `accept`. These checks stay
// offline: registration and argument handling are decided before any
// daemon connection.

test('endo store --help advertises --locator with stdin and --locator-file', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'store',
    '--help',
  ]);
  t.regex(stdout, /--locator <locator>/);
  t.regex(stdout, /--locator-file <path>/);
  t.regex(stdout, /stdin/);
});

test('endo --help no longer lists adopt-locator', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, '--help']);
  t.notRegex(stdout, /adopt-locator/);
});

test('endo store --locator conflicts with other store modes', async t => {
  const result = await execa(
    process.execPath,
    [
      endoBin,
      'store',
      '--locator',
      'endo://example',
      '--text',
      'hello',
      '--name',
      'x',
    ],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(result.stderr, /exactly one store flag/);
});

test('endo store --locator conflicts with --locator-file', async t => {
  const result = await execa(
    process.execPath,
    [
      endoBin,
      'store',
      '--locator',
      '-',
      '--locator-file',
      'loc.txt',
      '--name',
      'x',
    ],
    { reject: false, input: '' },
  );
  t.not(result.exitCode, 0);
  t.regex(result.stderr, /exactly one store flag/);
});

test('endo store --locator - refuses an empty locator before connecting', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'store', '--locator', '-', '--name', 'remote-guest'],
    { reject: false, input: '\n' },
  );
  t.not(result.exitCode, 0);
  t.regex(result.stderr, /no locator given/);
});
