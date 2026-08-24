// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from '../src/code-mode-provision-policy.js';

test('introduced names round-trip without nested source paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-code-mode-persistence-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const persistence = await normalizeEndoProvisionSpec(
    { introducedNames: { 'calendar-service': 'calendar' } },
    { harness: 'test', sessionId: 'round-trip', cwd: root },
  );
  const roundTrip = await validateEndoProvisionPersistence(persistence);
  t.deepEqual(roundTrip, persistence);
  t.deepEqual(roundTrip.introducedNames, {
    'calendar-service': 'calendar',
  });
  t.false(JSON.stringify(roundTrip).includes('formula'));
  t.false(JSON.stringify(roundTrip).includes('sessionId'));
});
