// @ts-check
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'ava';

const execFileAsync = promisify(execFile);

test('the shim preserves global constructor descriptors in a Node VM', async t => {
  const probe = new URL('./_shim-vm-realm-probe.mjs', import.meta.url);
  await t.notThrowsAsync(
    execFileAsync(process.execPath, [
      '--experimental-vm-modules',
      fileURLToPath(probe),
    ]),
  );
});
