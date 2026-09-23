// @ts-check

import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const endoBin = path.join(dirname, '..', 'bin', 'endo.cjs');

// `endo adopt-locator` is the CLI surface for the host's
// `adoptFromLocator`, distinct from message-attachment `adopt` and
// invitation `accept`. These checks stay offline: registration and
// argument handling are decided before any daemon connection.

test('endo --help lists adopt-locator beside adopt', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, '--help']);
  t.regex(stdout, /\badopt-locator\b/);
  t.regex(stdout, /\badopt\b/);
});

test('endo adopt-locator --help advertises stdin and --file input', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'adopt-locator',
    '--help',
  ]);
  t.regex(stdout, /Usage: endo adopt-locator \[options\] <name>/);
  t.regex(stdout, /--file <path>/);
  t.regex(stdout, /stdin/);
});

test('endo adopt-locator requires a pet name', async t => {
  const result = await execa(process.execPath, [endoBin, 'adopt-locator'], {
    reject: false,
    input: '',
  });
  t.not(result.exitCode, 0);
});

test('endo adopt-locator refuses an empty locator before connecting', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'adopt-locator', 'remote-guest'],
    { reject: false, input: '\n' },
  );
  t.not(result.exitCode, 0);
  t.regex(result.stderr, /no locator given/);
});
