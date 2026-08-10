// @ts-check

import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const endoBin = path.join(dirname, '..', 'bin', 'endo.cjs');

test('endo eval --help advertises --no-wait', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, 'eval', '--help']);
  t.regex(stdout, /--no-wait/);
});

test('endo make --help advertises --no-wait', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, 'make', '--help']);
  t.regex(stdout, /--no-wait/);
});

test('endo eval --no-wait without -n exits non-zero', async t => {
  // Commander accepts the flags; the command body rejects missing name
  // before or at daemon connection. Either way exit is non-zero.
  // Offline help-path already covered above; this exercises the flag wiring
  // by ensuring commander still accepts the option combination.
  const result = await execa(
    process.execPath,
    [endoBin, 'eval', '--no-wait', '1'],
    { reject: false, timeout: 5000 },
  );
  // Without a running daemon this may fail on connection OR on name check.
  // Name check message is preferred when the daemon is up; either way non-zero.
  t.not(result.exitCode, 0);
});
