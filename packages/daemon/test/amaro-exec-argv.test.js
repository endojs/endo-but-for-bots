import test from 'ava';
import { makeAmaroExecArgv, amaroStripUrl } from '../src/amaro-exec-argv.js';

test('appends the amaro/strip hook when the parent lacks it', t => {
  t.deepEqual(makeAmaroExecArgv([]), ['--import', amaroStripUrl]);
  t.deepEqual(makeAmaroExecArgv(['--inspect']), [
    '--inspect',
    '--import',
    amaroStripUrl,
  ]);
});

test('keeps the parent flags when the hook is already present', t => {
  for (const execArgv of [
    ['--import=amaro/strip'],
    [`--import=${amaroStripUrl}`],
    ['--import', 'amaro/strip'],
    ['--import', amaroStripUrl],
  ]) {
    const result = makeAmaroExecArgv(execArgv);
    t.deepEqual(result, execArgv);
    t.not(result, execArgv);
  }
});

test('does not mistake the specifier for an unrelated flag value', t => {
  t.deepEqual(makeAmaroExecArgv(['--require', 'amaro/strip']), [
    '--require',
    'amaro/strip',
    '--import',
    amaroStripUrl,
  ]);
});
