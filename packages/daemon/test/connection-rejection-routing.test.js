// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { execFile } from 'node:child_process';
import { execPath } from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const expectedLockdownDiagnostics = `SES Removing unpermitted intrinsics
  Removing intrinsics.%InitialURL%.createObjectURL.prototype
  Tolerating undeletable intrinsics.%InitialURL%.createObjectURL.prototype === undefined
  Removing intrinsics.%InitialURL%.revokeObjectURL.prototype
  Tolerating undeletable intrinsics.%InitialURL%.revokeObjectURL.prototype === undefined
  Removing intrinsics.%URLSearchParamsIteratorPrototype%.RegisteredSymbol(nodejs.util.inspect.custom)
  Removing intrinsics.%URLSearchParamsPrototype%.RegisteredSymbol(nodejs.util.inspect.custom)
  Removing intrinsics.%URLPrototype%.RegisteredSymbol(nodejs.util.inspect.custom)
`;

test('transport write failure has one onReject presentation path', async t => {
  const fixture = new URL('./fixtures/captp-write-failure.js', import.meta.url);
  const { stdout, stderr } = await execFileAsync(execPath, [fixture.pathname]);

  t.is(stderr, expectedLockdownDiagnostics);
  t.deepEqual(JSON.parse(stdout), [{ kind: 'disconnect' }]);
});
