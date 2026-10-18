/* global process */
import test from 'ava';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const endoBin = fileURLToPath(new URL('../bin/endo.cjs', import.meta.url));

const runEndo = (nodeArgs, endoArgs) =>
  spawnSync(process.execPath, [...nodeArgs, endoBin, ...endoArgs], {
    encoding: 'utf8',
  });

test('endo exits with an error when Node.js cannot strip types', t => {
  const result = runEndo(['--no-experimental-strip-types'], ['--help']);
  t.is(result.status, 1);
  t.regex(result.stderr, /endo requires Node\.js type stripping/);
});

test('endo loads its .ts dependencies when Node.js strips types', t => {
  const result = runEndo([], ['--help']);
  t.is(result.status, 0, result.stderr);
  t.regex(result.stdout, /Usage: endo/);
});
