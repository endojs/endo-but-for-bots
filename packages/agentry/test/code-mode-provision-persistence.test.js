// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeEndoProvisionSpec,
  validateEndoProvisionPersistence,
} from '../src/code-mode-provision-policy.js';

test('caller persistence is only a versioned opaque guest identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-code-mode-persistence-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const request = await normalizeEndoProvisionSpec(
    {
      mount: { workspace: { path: '.', mode: 'readOnly' } },
      introducedNames: { 'calendar-service': 'calendar' },
    },
    { harness: 'test', sessionId: 'round-trip', cwd: root },
  );
  const roundTrip = await validateEndoProvisionPersistence(request.persistence);
  t.deepEqual(roundTrip, request.persistence);
  t.deepEqual(Object.keys(roundTrip), ['version', 'guestName']);
  t.false(JSON.stringify(roundTrip).includes(root));
  t.false(JSON.stringify(roundTrip).includes('calendar'));
  t.false(JSON.stringify(roundTrip).includes('workspace'));
  t.false(JSON.stringify(roundTrip).includes('authority'));
  t.false(JSON.stringify(roundTrip).includes('spec'));
});

test('persistence validation rejects policy-shaped extra fields', async t => {
  await t.throwsAsync(
    () =>
      validateEndoProvisionPersistence({
        version: 4,
        guestName: 'code-mode-test-opaque',
        authority: {},
      }),
    { message: /unknown field.*authority/ },
  );
});
