import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import test from '@endo/ses-ava/test.js';

const execute = promisify(execFile);
const fixture = fileURLToPath(
  new URL('./parcel-pre-shim-fixture.js', import.meta.url),
);

const scenarios = [
  'absent',
  'well-shaped',
  'unfrozen-check',
  'unfrozen-prototype',
  'null-prototype',
  'prototype-method',
  'accessor-tag',
  'wrong-tag',
  'foreign-parent',
  'foreign-constructor',
  'enumerable-tag',
  'accessor-check',
  'accessor-global',
  'replacement',
  'captured',
  'lying',
  'malformed',
  'reentrant',
  'throwing',
  'unfrozen-global',
];

for (const scenario of scenarios) {
  test(`pre-shim Parcel trust boundary: ${scenario}`, async t => {
    await t.notThrowsAsync(
      execute(process.execPath, [fixture, scenario], { timeout: 30_000 }),
    );
  });
}
