// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { execFile } from 'node:child_process';
import { execPath } from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('transport write failure has one onReject presentation path', async t => {
  const fixture = new URL('./fixtures/captp-write-failure.js', import.meta.url);
  const { stdout, stderr } = await execFileAsync(execPath, [fixture.pathname]);

  t.is(stderr, '');
  t.deepEqual(JSON.parse(stdout), [{ kind: 'disconnect' }]);
});
